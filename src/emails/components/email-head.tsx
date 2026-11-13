import { Head } from "@react-email/components"

export function EmailHead({ title }: { title: string }) {
  return (
    <Head>
      <title>{title}</title>
      <meta name="color-scheme" content="light only" />
      <meta name="supported-color-schemes" content="light only" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500&family=Red+Hat+Text:wght@400;500;600&display=swap"
      />
      <style>{`
        :root { color-scheme: light only; }
        .mail-content > p:first-child { margin-top: 0 !important; }
        .mail-content > p:last-child { margin-bottom: 0 !important; }
        @media (max-width: 380px) { .mail-content { padding: 24px 20px !important; } .mail-footer { padding: 20px !important; } }
      `}</style>
    </Head>
  )
}
