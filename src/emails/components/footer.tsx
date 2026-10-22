import { Container, Link, Section, Text } from "@react-email/components"
import type { ReactNode } from "react"

/** `children` replaces the "do not reply" note. */
export function Footer({ children }: { children?: ReactNode }) {
  return (
    <Section className="py-5 text-center bg-gray-100">
      <Container className="px-5">
        <Link href="https://polinetwork.org" className="text-xs text-[#1156AE] underline">
          PoliNetwork APS
        </Link>
        <Text className="text-xs text-gray-700">
          {children ?? (
            <>
              This is an automated message. <br /> Please <strong>do not reply</strong> to this email directly as you
              will not receive a response.
            </>
          )}
        </Text>
      </Container>
    </Section>
  )
}
