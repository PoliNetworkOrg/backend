import { Body, Button, Heading, Html, Img, Preview, Text } from "@react-email/components"
import type { ComponentProps, CSSProperties, ReactNode } from "react"
import { EMAIL_HEADERS, type EmailHeaderKind, headerCid } from "../headers"
import { EmailHead } from "./email-head"
import { Footer } from "./footer"

export const textFont = "'Red Hat Text', Helvetica, Arial, sans-serif"
export const linkStyle: CSSProperties = { color: "#0369a1", textDecoration: "underline", overflowWrap: "anywhere" }
export const smallText: CSSProperties = { fontSize: 14, lineHeight: "23px" }

export function MailText({ style, ...props }: ComponentProps<typeof Text>) {
  return (
    <Text
      {...props}
      style={{
        margin: "16px 0",
        fontFamily: textFont,
        fontSize: 16,
        lineHeight: "26px",
        color: "#0f172a",
        overflowWrap: "anywhere",
        ...style,
      }}
    />
  )
}

export function MailAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "24px 0" }}>
      <tbody>
        <tr>
          <td align="center">
            <Button
              href={href}
              style={{
                display: "inline-block",
                boxSizing: "border-box",
                maxWidth: "100%",
                borderRadius: 60,
                backgroundColor: "#49a0ff",
                padding: "14px 24px",
                color: "#020617",
                textDecoration: "none",
                fontFamily: textFont,
                fontWeight: 500,
                fontSize: 16,
                lineHeight: "24px",
                textAlign: "center",
              }}
            >
              {children}
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export function EmailLayout({
  kind,
  preview,
  children,
  footer,
}: {
  kind: EmailHeaderKind
  preview: string
  children: ReactNode
  footer?: ReactNode
}) {
  const title = EMAIL_HEADERS[kind]
  const height = kind === "request-completed" || kind === "request-delivery-failed" ? 222 : 183
  return (
    <Html lang="it">
      <EmailHead title={title} />
      <Preview>{preview}</Preview>
      <Body style={{ margin: 0, padding: 0, fontFamily: textFont, color: "#0f172a" }}>
        <table className="email-frame" role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td style={{ padding: "32px 0" }}>
                <table
                  className="email-card"
                  role="presentation"
                  width="100%"
                  align="center"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{
                    width: "100%",
                    maxWidth: 520,
                    margin: "0 auto",
                    border: "1px solid #e2e8f0",
                    borderRadius: 20,
                    overflow: "hidden",
                    backgroundColor: "#ffffff",
                    tableLayout: "fixed",
                  }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: 0, borderRadius: "19px 19px 0 0", overflow: "hidden" }}>
                        <Heading
                          as="h1"
                          style={{ margin: 0, fontSize: 32, lineHeight: "39px", fontWeight: 500, color: "#020617" }}
                        >
                          <Img
                            className="email-header"
                            src={`cid:${headerCid(kind)}`}
                            alt={`PoliNetwork — ${title}`}
                            width={518}
                            height={height}
                            style={{
                              display: "block",
                              border: 0,
                              width: "100%",
                              maxWidth: 518,
                              height: "auto",
                              borderRadius: "19px 19px 0 0",
                            }}
                          />
                        </Heading>
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="mail-content"
                        style={{ padding: "26px 28px 32px", fontFamily: textFont, fontSize: 16, lineHeight: "26px" }}
                      >
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="mail-footer"
                        style={{
                          padding: "22px 28px",
                          borderTop: "1px solid #e2e8f0",
                          backgroundColor: "#f8fafc",
                          fontFamily: textFont,
                          fontSize: 12,
                          lineHeight: "19px",
                          color: "#64748b",
                          borderRadius: "0 0 19px 19px",
                        }}
                      >
                        <Footer>{footer}</Footer>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </Body>
    </Html>
  )
}
