import { Link } from "@react-email/components"
import type { ReactNode } from "react"

export function Footer({ children }: { children?: ReactNode }) {
  return (
    <>
      {children ?? <>Messaggio automatico. Non rispondere a questa email: non riceveresti risposta.</>}
      <br />
      <Link href="https://polinetwork.org" style={{ color: "#0369a1", textDecoration: "underline" }}>
        PoliNetwork APS
      </Link>
    </>
  )
}
