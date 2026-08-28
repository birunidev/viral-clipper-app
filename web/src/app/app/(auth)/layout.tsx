import { Play, Scissors, Waveform } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

const FEATURES = [
  { icon: Waveform, label: "Transcribes every word" },
  { icon: Play, label: "Finds the hook" },
  { icon: Scissors, label: "Cuts it to size" },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-1">
      {/* Product context panel — hidden on mobile */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden border-r border-line bg-surface-1 p-10 lg:flex">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Scissors size={15} weight="bold" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">ClipZard</span>
        </Link>

        <div className="max-w-sm">
          <p className="text-2xl font-semibold leading-tight tracking-tight text-ink balance">
            Long videos in. Viral clips out.
          </p>
          <div className="mt-8 flex flex-col gap-3">
            {FEATURES.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-3 text-sm text-ink-secondary">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-tertiary">
                  <Icon size={15} />
                </span>
                {label}
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-ink-muted">No credit card required.</p>
          <p className="mt-1 text-xs text-ink-muted">
            By continuing you agree to our{" "}
            <Link href="/terms" className="underline underline-offset-4 hover:text-ink">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">
              Privacy Policy
            </Link>
            .
          </p>
        </div>

        {/* subtle timeline decoration */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-accent/[0.06] blur-3xl"
        />
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </div>
  );
}
