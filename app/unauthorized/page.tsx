
import Link from "next/link";

export default function UnauthorizedPage() {
    return (
        <main className="flex min-h-screen items-center justify-center bg-page px-5 text-ink">
            <div className="max-w-md rounded-3xl bg-surface p-8 text-center shadow-lg">
                <h1 className="text-3xl font-bold">
                    Access Restricted
                </h1>

                <p className="mt-4 text-muted">
                    This tool is only available to authorized
                    superadmins.
                </p>

                <Link
                    href="/login"
                    className="mt-6 inline-block rounded-xl bg-primary px-6 py-3 font-semibold text-on-primary"
                >
                    Return to Login
                </Link>
            </div>
        </main>
    );
}
