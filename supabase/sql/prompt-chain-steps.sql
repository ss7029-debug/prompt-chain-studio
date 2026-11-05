-- Run this entire file manually in Supabase SQL Editor before using step mutations.
-- Adds one function only; existing tables, constraints, policies and data are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.manage_prompt_chain_steps(
  p_chain_id bigint,
  p_operation text,
  p_step_id bigint DEFAULT NULL,
  p_prompt_text text DEFAULT NULL,
  p_expected_steps jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_ids bigint[];
  v_snapshot jsonb;
  v_index integer;
  v_neighbor integer;
  v_swap bigint;
  v_new_id bigint;
BEGIN
  -- Never trust the caller's role, parameters, or frontend authorization.
  -- Hold the profile lock so access cannot be revoked midway through a mutation.
  PERFORM 1 FROM public.profiles
    WHERE id = auth.uid() AND is_superadmin IS TRUE
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Superadmin access required.' USING ERRCODE = '42501';
  END IF;

  IF p_operation IS NULL OR p_operation NOT IN ('create', 'edit', 'delete', 'up', 'down') THEN
    RAISE EXCEPTION 'Invalid step operation.' USING ERRCODE = '22023';
  END IF;
  IF p_expected_steps IS NULL OR jsonb_typeof(p_expected_steps) <> 'array' THEN
    RAISE EXCEPTION 'A complete step snapshot is required.' USING ERRCODE = '22023';
  END IF;
  IF p_operation IN ('create', 'edit') AND
     (p_prompt_text IS NULL OR length(btrim(p_prompt_text, E' \t\n\r')) = 0 OR length(p_prompt_text) > 50000) THEN
    RAISE EXCEPTION 'Prompt text must contain 1 to 50000 characters.' USING ERRCODE = '22023';
  END IF;

  -- All app mutations, including creates and text edits, use this same lock.
  -- It also coordinates with ordinary updates/deletes of the parent chain.
  PERFORM 1 FROM public.prompt_chains WHERE id = p_chain_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prompt chain no longer exists.' USING ERRCODE = 'PT404';
  END IF;
  PERFORM 1 FROM public.prompt_chain_steps
    WHERE prompt_chain_id = p_chain_id ORDER BY id FOR UPDATE;

  SELECT
    coalesce(array_agg(s.id ORDER BY s.step_number NULLS LAST, s.id), ARRAY[]::bigint[]),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id::text, 'step_number', s.step_number, 'prompt_text', s.prompt_text
    ) ORDER BY s.step_number NULLS LAST, s.id), '[]'::jsonb)
  INTO v_ids, v_snapshot
  FROM public.prompt_chain_steps AS s WHERE s.prompt_chain_id = p_chain_id;

  -- Reject stale browser tabs instead of silently overwriting another admin's work.
  IF v_snapshot IS DISTINCT FROM p_expected_steps THEN
    RAISE EXCEPTION 'Steps changed. Refresh before trying again.' USING ERRCODE = 'PT409';
  END IF;

  IF p_operation <> 'create' THEN
    v_index := array_position(v_ids, p_step_id);
    IF v_index IS NULL THEN
      RAISE EXCEPTION 'Step does not belong to this chain or no longer exists.' USING ERRCODE = 'PT404';
    END IF;
  END IF;

  IF p_operation = 'create' THEN
    INSERT INTO public.prompt_chain_steps (prompt_chain_id, step_number, prompt_text)
      VALUES (p_chain_id, cardinality(v_ids) + 1, p_prompt_text)
      RETURNING id INTO v_new_id;
    v_ids := array_append(v_ids, v_new_id);
  ELSIF p_operation = 'edit' THEN
    UPDATE public.prompt_chain_steps SET prompt_text = p_prompt_text
      WHERE id = p_step_id AND prompt_chain_id = p_chain_id;
  ELSIF p_operation = 'delete' THEN
    DELETE FROM public.prompt_chain_steps WHERE id = p_step_id AND prompt_chain_id = p_chain_id;
    v_ids := array_remove(v_ids, p_step_id);
  ELSE
    v_neighbor := v_index + CASE WHEN p_operation = 'up' THEN -1 ELSE 1 END;
    IF v_neighbor < 1 OR v_neighbor > cardinality(v_ids) THEN
      RAISE EXCEPTION 'Step is already at the boundary.' USING ERRCODE = '22023';
    END IF;
    v_swap := v_ids[v_neighbor];
    v_ids[v_neighbor] := v_ids[v_index];
    v_ids[v_index] := v_swap;
  END IF;

  -- One statement renumbers all remaining steps; every change is in the RPC transaction.
  -- This relies on the confirmed absence of an immediate unique step-number constraint.
  UPDATE public.prompt_chain_steps AS s
    SET step_number = ordering.position::integer
    FROM unnest(v_ids) WITH ORDINALITY AS ordering(id, position)
    WHERE s.id = ordering.id AND s.prompt_chain_id = p_chain_id
      AND s.step_number IS DISTINCT FROM ordering.position::integer;
END;
$function$;

-- Definer execution is available only to authenticated users, with the explicit
-- superadmin check above. No service-role key is used by the application.
REVOKE ALL ON FUNCTION public.manage_prompt_chain_steps(bigint, text, bigint, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_prompt_chain_steps(bigint, text, bigint, text, jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
