
import Link from "next/link";

export default function UnauthorizedPage() {
    return (
        <main className="flex min-h-screen items-center justify-center bg-[#F5D5DF] px-5 text-[#593B32]">
            <div className="max-w-md rounded-3xl bg-[#FFF8EE] p-8 text-center shadow-lg">
                <h1 className="text-3xl font-bold">
                    Access Restricted
                </h1>

                <p className="mt-4 text-[#765044]">
                    This tool is only available to authorized
                    superadmins.
                </p>

                <Link
                    href="/login"
                    className="mt-6 inline-block rounded-xl bg-[#593B32] px-6 py-3 font-semibold text-white"
                >
                    Return to Login
                </Link>
            </div>
        </main>
    );
}
