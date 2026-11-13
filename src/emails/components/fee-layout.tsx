import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  pixelBasedPreset,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import type { ReactNode } from "react"
import { Footer } from "./footer"
import { Logo } from "./logo"

/** The frame of every Soci email: Italian, greeting the socio by the name they go by, with an optional button. */
export function FeeLayout(props: {
  preview: string
  title: string
  name: string
  /** The button to My area, if any. */
  action?: { label: string; href: string }
  children: ReactNode
}) {
  return (
    <Html lang="it">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>{props.preview}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto max-w-[460px] bg-white px-5">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{props.title}</Heading>
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">
                Ciao <strong>{props.name}</strong>,
              </Text>
              {props.children}
              {props.action ? (
                <Section className="my-6 text-center">
                  <Button
                    href={props.action.href}
                    className="rounded-md bg-[#1156AE] px-5 py-3 text-sm font-semibold text-white"
                  >
                    {props.action.label}
                  </Button>
                </Section>
              ) : null}
              <Text className="my-2 text-sm leading-normal text-gray-700">~ Il Consiglio Direttivo di PoliNetwork</Text>
            </Section>
          </Container>
          <Footer>
            Questo è un messaggio automatico: <strong>non rispondere</strong> a questa email. Per domande scrivi al
            Consiglio Direttivo a{" "}
            <Link href="mailto:direttivo@polinetwork.org" className="text-[#1156AE] underline">
              direttivo@polinetwork.org
            </Link>
            .
          </Footer>
        </Body>
      </Tailwind>
    </Html>
  )
}
