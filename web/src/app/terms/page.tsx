import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The Terms of Service governing your use of ClipZard.",
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

export default function TermsPage() {
  return (
    <main className="grain flex-1">
      <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10 md:py-20">
        <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">
          Legal · Effective 27 August 2026
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Terms of Service
        </h1>
        <p className="mt-3 text-sm text-ink-tertiary">
          ClipZard is provided by BiruniDev. Contact:{" "}
          <a href="mailto:hello@birunidev.com" className="text-accent underline underline-offset-4">
            hello@birunidev.com
          </a>
        </p>

        <Section title="1. The Service">
          <p>
            ClipZard is a tool that transcribes long-form videos, identifies the moments most
            likely to go viral, and cuts them into short clips. By using the Service you agree to
            be bound by these Terms and our Privacy Policy.
          </p>
        </Section>

        <Section title="2. Your Account">
          <p>
            To use the Service you must create an account with a valid email address and password.
            You are responsible for keeping your login credentials confidential and for all
            activity under your account. You must not create accounts through automated means
            without our permission, and you must provide accurate information.
          </p>
        </Section>

        <Section title="3. Credits &amp; Entitlements">
          <p>
            ClipZard operates on a prepaid credit model. One credit equals one minute of source
            video processed. Credits never expire. Purchasing a credit pack permanently unlocks
            the entitlement tier associated with that pack (storage, resolution, project limits,
            and watermark removal). Limits are described in the app at the time of purchase.
          </p>
        </Section>

        <Section title="4. Content &amp; Your Responsibilities">
          <p>
            You retain all rights to the videos and files you provide. You represent that you own
            the content you upload or link to, or that you have the rights and permissions to use
            it — including, where applicable, compliance with YouTube&apos;s Terms of Service. You are
            solely responsible for the clips you create and publish.
          </p>
          <p>You agree not to use the Service to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Infringe the intellectual property or other rights of any third party;</li>
            <li>Upload unlawful, harmful, defamatory, or obscene material;</li>
            <li>Attempt to disrupt, overload, or gain unauthorised access to the Service;</li>
            <li>Reverse-engineer or misuse the Service in any way not intended.</li>
          </ul>
        </Section>

        <Section title="5. Payments">
          <p>
            Payment for credits is processed by our payment providers. For customers worldwide we
            use Paddle Billing, which acts as the Merchant of Record and handles applicable taxes
            and invoicing. For customers in Indonesia we use Midtrans, which supports GoPay, OVO,
            QRIS, virtual accounts, and cards settled in Indonesian Rupiah as a fixed-term pass.
          </p>
          <p>
            All purchases are final and non-refundable except where required by applicable law.
          </p>
        </Section>

        <Section title="6. Storage &amp; Retention">
          <p>
            Stored content is kept for the duration of your account. Projects you delete are moved
            to a trash state and are permanently removed after a retention period. We may remove
            content that violates these Terms or applicable law.
          </p>
        </Section>

        <Section title="7. Acceptable Use &amp; Termination">
          <p>
            We may suspend or terminate your access if you breach these Terms, violate applicable
            law, or misuse the Service. Upon termination, your right to use the Service ceases. You
            may stop using the Service at any time by deleting your account.
          </p>
        </Section>

        <Section title="8. Disclaimer of Warranties">
          <p>
            The Service is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind,
            whether express or implied, including fitness for a particular purpose. We do not
            warrant that the Service will be uninterrupted, error-free, or that the clips produced
            will achieve any particular level of engagement.
          </p>
        </Section>

        <Section title="9. Limitation of Liability">
          <p>
            To the maximum extent permitted by law, BiruniDev and ClipZard shall not be liable for
            any indirect, incidental, special, consequential, or punitive damages, or for any loss
            of profits, data, or goodwill arising from your use of the Service.
          </p>
        </Section>

        <Section title="10. Governing Law">
          <p>
            These Terms are governed by the laws of the Republic of Indonesia, without regard to
            its conflict-of-law provisions. Any disputes shall be subject to the exclusive
            jurisdiction of the competent courts of Indonesia.
          </p>
        </Section>

        <Section title="11. Changes to These Terms">
          <p>
            We may update these Terms from time to time. Material changes will be communicated to
            you, and continued use of the Service after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions about these Terms can be sent to{" "}
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
