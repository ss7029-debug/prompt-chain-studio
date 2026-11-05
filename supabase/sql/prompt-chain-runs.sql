-- MANUAL INSTALLATION ONLY: review and run the entire script in Supabase SQL Editor.
-- Adds a dedicated table and two RPCs. Does not use or alter NYC Unlocked's result tables.
-- Deliberately fails if prompt_chain_runs already exists: inspect its schema first.
BEGIN;

CREATE TABLE public.prompt_chain_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_chain_id bigint REFERENCES public.prompt_chains(id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  chain_name text NOT NULL,
  initial_input text NOT NULL CHECK (length(initial_input) BETWEEN 1 AND 10000),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  steps_snapshot jsonb NOT NULL CHECK (jsonb_typeof(steps_snapshot) = 'array' AND jsonb_array_length(steps_snapshot) BETWEEN 1 AND 8),
  step_outputs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(step_outputs) = 'array' AND jsonb_array_length(step_outputs) <= 8),
  final_output text CHECK (length(final_output) <= 12000),
  error_message text CHECK (length(error_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND final_output IS NULL) OR
    (status = 'completed' AND finished_at IS NOT NULL AND final_output IS NOT NULL AND error_message IS NULL) OR
    (status = 'failed' AND finished_at IS NOT NULL AND final_output IS NULL AND error_message IS NOT NULL)
  )
);
CREATE INDEX prompt_chain_runs_chain_created_idx ON public.prompt_chain_runs (prompt_chain_id, created_at DESC, id DESC);
CREATE INDEX prompt_chain_runs_user_created_idx ON public.prompt_chain_runs (created_by, created_at DESC);
CREATE INDEX prompt_chain_runs_created_idx ON public.prompt_chain_runs (created_at DESC);

ALTER TABLE public.prompt_chain_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prompt_chain_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.prompt_chain_runs TO authenticated;
CREATE POLICY prompt_chain_runs_superadmin_read ON public.prompt_chain_runs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_superadmin IS TRUE));

CREATE FUNCTION public.begin_prompt_chain_run(p_chain_id bigint, p_initial_input text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_name text;
  v_steps jsonb;
  v_step jsonb;
  v_position bigint;
  v_id uuid;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = v_user AND is_superadmin IS TRUE FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Superadmin access required.' USING ERRCODE = '42501'; END IF;
  IF p_initial_input IS NULL OR length(btrim(p_initial_input, E' \t\n\r')) = 0 OR length(p_initial_input) > 10000 THEN
    RAISE EXCEPTION 'Enter initial input between 1 and 10000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(p_model) > 100 OR p_model !~ '^gemini-[a-zA-Z0-9.-]+$' THEN
    RAISE EXCEPTION 'Invalid model.' USING ERRCODE = '22023';
  END IF;

  -- One short global admission lock makes quotas work across processes and servers.
  PERFORM pg_advisory_xact_lock(hashtextextended('prompt-chain-studio:run-admission', 0));
  UPDATE public.prompt_chain_runs SET status = 'failed', finished_at = now(),
    error_message = 'Run interrupted or expired. Partial results may be unavailable.'
    WHERE status = 'running' AND created_at < now() - interval '5 minutes';
  IF EXISTS (SELECT 1 FROM public.prompt_chain_runs WHERE created_by = v_user AND status = 'running') THEN
    RAISE EXCEPTION 'You already have a running chain. Wait for it to finish (or expire after five minutes).' USING ERRCODE = 'PT429';
  END IF;
  IF (SELECT count(*) FROM public.prompt_chain_runs WHERE created_by = v_user AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'Limit of five runs per administrator per hour reached.' USING ERRCODE = 'PT429';
  END IF;
  IF (SELECT count(*) FROM public.prompt_chain_runs WHERE created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'Workspace limit of twenty runs per hour reached.' USING ERRCODE = 'PT429';
  END IF;

  -- The step management RPC takes FOR UPDATE on this same parent, so this is a
  -- consistent snapshot even if another admin is editing/reordering the chain.
  SELECT name INTO v_name FROM public.prompt_chains WHERE id = p_chain_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prompt chain no longer exists.' USING ERRCODE = 'PT404'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id::text, 'step_number', s.step_number, 'prompt_text', s.prompt_text
  ) ORDER BY s.step_number NULLS LAST, s.id), '[]'::jsonb)
    INTO v_steps FROM public.prompt_chain_steps AS s WHERE s.prompt_chain_id = p_chain_id;
  IF jsonb_array_length(v_steps) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'A chain must contain between one and eight steps to run.' USING ERRCODE = '22023';
  END IF;
  FOR v_step, v_position IN SELECT value, ordinality FROM jsonb_array_elements(v_steps) WITH ORDINALITY LOOP
    IF (v_step->>'step_number')::integer IS DISTINCT FROM v_position::integer OR
       v_step->>'prompt_text' IS NULL OR length(btrim(v_step->>'prompt_text', E' \t\n\r')) = 0 OR length(v_step->>'prompt_text') > 8000 THEN
      RAISE EXCEPTION 'Steps must be consecutive and contain 1 to 8000 characters of prompt text.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  INSERT INTO public.prompt_chain_runs (prompt_chain_id, created_by, chain_name, initial_input, model, steps_snapshot)
    VALUES (p_chain_id, v_user, v_name, p_initial_input, p_model, v_steps) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'steps', v_steps);
END;
$function$;

CREATE FUNCTION public.finish_prompt_chain_run(p_run_id uuid, p_status text, p_outputs jsonb, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_run public.prompt_chain_runs%ROWTYPE;
  v_output jsonb;
  v_position bigint;
  v_expected jsonb;
  v_final text;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = auth.uid() AND is_superadmin IS TRUE FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Superadmin access required.' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_run FROM public.prompt_chain_runs WHERE id = p_run_id AND created_by = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found.' USING ERRCODE = 'PT404'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') OR
     p_outputs IS NULL OR jsonb_typeof(p_outputs) <> 'array' OR jsonb_array_length(p_outputs) > jsonb_array_length(v_run.steps_snapshot) THEN
    RAISE EXCEPTION 'Invalid run result.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'completed' AND (jsonb_array_length(p_outputs) <> jsonb_array_length(v_run.steps_snapshot) OR p_error IS NOT NULL) THEN
    RAISE EXCEPTION 'A completed run must include every step.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'failed' AND (p_error IS NULL OR length(p_error) NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'A failed run requires an error message.' USING ERRCODE = '22023';
  END IF;
  FOR v_output, v_position IN SELECT value, ordinality FROM jsonb_array_elements(p_outputs) WITH ORDINALITY LOOP
    v_expected := v_run.steps_snapshot->(v_position::integer - 1);
    IF jsonb_typeof(v_output) <> 'object' OR
       (v_output->>'step_id') IS DISTINCT FROM (v_expected->>'id') OR
       (v_output->>'step_number') IS DISTINCT FROM (v_expected->>'step_number') OR
       jsonb_typeof(v_output->'output') IS DISTINCT FROM 'string' OR
       length(btrim(v_output->>'output', E' \t\n\r')) = 0 OR length(v_output->>'output') > 12000 THEN
      RAISE EXCEPTION 'Invalid step output.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_run.status <> 'running' THEN
    -- Safe to repeat a save after an ambiguous network response; never duplicate a run.
    IF v_run.status = p_status AND v_run.step_outputs = p_outputs AND v_run.error_message IS NOT DISTINCT FROM p_error THEN RETURN; END IF;
    RAISE EXCEPTION 'This run has already finished.' USING ERRCODE = 'PT409';
  END IF;
  IF v_run.created_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'Run expired. Results were not saved.' USING ERRCODE = 'PT409';
  END IF;
  v_final := CASE WHEN p_status = 'completed' THEN p_outputs->-1->>'output' ELSE NULL END;
  UPDATE public.prompt_chain_runs SET status = p_status, step_outputs = p_outputs,
    final_output = v_final, error_message = p_error, finished_at = now() WHERE id = p_run_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_prompt_chain_run(bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_prompt_chain_run(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_prompt_chain_run(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_prompt_chain_run(uuid, text, jsonb, text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
