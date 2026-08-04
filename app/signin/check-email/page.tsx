import Link from "next/link";

export default function CheckEmailPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-charcoal p-4">
      <div className="w-full max-w-sm rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
        <div className="px-5 py-4 bg-[#353535] border-b border-charcoal-dark">
          <h1 className="text-white text-lg font-semibold">Check your email</h1>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-gray-300 text-sm">
            We sent you a sign-in link. Open it on this device and you&apos;ll be signed in.
          </p>
          <p className="text-gray-500 text-xs">
            The link is good for 15 minutes and can only be used once. If it doesn&apos;t
            arrive within a minute, check your spam folder.
          </p>
          <Link
            href="/signin"
            className="inline-block text-sm text-[#50C878] hover:brightness-110"
          >
            Use a different email
          </Link>
        </div>
      </div>
    </main>
  );
}
