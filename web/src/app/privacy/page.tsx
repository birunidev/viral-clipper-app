import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How ClipZard collects, uses, and protects your personal data.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-[15px] leading-relaxed text-ink-tertiary">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="grain flex-1">
      <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10 md:py-20">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">
          Legal · Effective 27 August 2026
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="mt-3 text-sm text-ink-tertiary">
          ClipZard is provided by BiruniDev. Contact:{" "}
          <a href="mailto:hello@birunidev.com" className="text-accent underline underline-offset-4">
            hello@birunidev.com
          </a>
        </p>

        <Section title="1. Data We Collect">
          <p>We collect the following data when you use ClipZard:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-ink">Account data</strong> — your name and email address.
            </li>
            <li>
              <strong className="text-ink">Usage data</strong> — IP address, browser user-agent,
              and device information, used to secure your session and the Service.
            </li>
            <li>
              <strong className="text-ink">Content you provide</strong> — the videos you upload or
              link to, their transcripts, thumbnails, and the clips you create.
            </li>
            <li>
              <strong className="text-ink">Billing data</strong> — handled by our payment
              providers (Paddle or Midtrans); we store the plan, amounts, and order identifiers,
              but not your full card details.
            </li>
          </ul>
        </Section>

        <Section title="2. How We Use Data">
          <p>We use your data to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Provide, operate, and maintain the Service;</li>
            <li>Process videos into clips and deliver results;</li>
            <li>Authenticate you and keep your account secure;</li>
            <li>Process payments and manage your credits and entitlements;</li>
            <li>Improve the Service and provide support.</li>
          </ul>
        </Section>

        <Section title="3. Legal Basis">
          <p>
            We process your data on the basis of contract (to provide the Service you request),
            your consent (for account creation), and our legitimate interests (security and
            service improvement), consistent with applicable data-protection law, including
            Indonesia&apos;s Personal Data Protection Law (UU PDP) where it applies.
          </p>
        </Section>

        <Section title="4. Service Providers">
          <p>We share data only with the processors needed to run the Service:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-ink">Object storage (Cloudflare R2 / S3)</strong> — stores
              your videos and clips.
            </li>
            <li>
              <strong className="text-ink">Database (PostgreSQL)</strong> — stores account and
              project data.
            </li>
            <li>
              <strong className="text-ink">Transcription &amp; analysis</strong> — AssemblyAI
              and/or your configured LLM provider process content to find viral moments.
            </li>
            <li>
              <strong className="text-ink">Payment providers</strong> — Paddle and Midtrans
              process your payments.
            </li>
          </ul>
          <p>
            We do not sell your personal data. If you bring your own API keys (BYOK), your content
            is processed through the providers you choose.
          </p>
        </Section>

        <Section title="5. Cookies &amp; Sessions">
          <p>
            We use a single httpOnly session cookie to keep you signed in. It does not contain
            personal information in plaintext. We do not use third-party advertising cookies.
          </p>
        </Section>

        <Section title="6. Retention">
          <p>
            We retain your account data for as long as your account is active. Content you delete
            is removed after a short retention period. We may retain data longer where required by
            law or for legitimate business, security, and audit purposes.
          </p>
        </Section>

        <Section title="7. Your Rights">
          <p>
            You may request access to, correction of, or deletion of your personal data, and you
            may withdraw consent or object to processing. To exercise these rights, contact us at{" "}
            <a href="mailto:hello@birunidev.com" className="text-accent underline underline-offset-4">
              hello@birunidev.com
            </a>
            .
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            Passwords are hashed with Argon2, session tokens are stored hashed, and sensitive
            data is encrypted in transit and at rest. No method of transmission or storage is
            completely secure, but we take reasonable measures to protect your data.
          </p>
        </Section>

        <Section title="9. Changes to This Policy">
          <p>
            We may update this policy as our practices or legal obligations change. Material
            changes will be communicated to you. Continued use of the Service after changes take
            effect constitutes acceptance.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            For any privacy questions or requests, contact us at{" "}
            <a href="mailto:hello@birunidev.com" className="text-accent underline underline-offset-4">
              hello@birunidev.com
            </a>
            .
          </p>
        </Section>

        <div className="mt-12 border-t border-line pt-6">
          <Link href="/" className="text-sm text-ink-tertiary underline underline-offset-4 hover:text-ink">
            Back to ClipZard
          </Link>
        </div>
      </div>
    </main>
  );
}
