import { render } from "@react-email/components"
import { describe, expect, it } from "vitest"
import RegulationEmanatedEmail, { attachedLine } from "@/emails/templates/regulation-emanated"

describe("the Soci's emanation email", () => {
  it("names only the PDFs really attached", () => {
    expect(attachedLine({ official: "rri.pdf", differences: "differenze.pdf" })).toBe(
      "In allegato il testo ufficiale (rri.pdf) e il documento delle differenze (differenze.pdf), che non ha valore ufficiale."
    )
    expect(attachedLine({ official: "rri.pdf", differences: null })).toBe("In allegato il testo ufficiale (rri.pdf).")
    expect(attachedLine({ official: null, differences: null })).toBeNull()
  })

  it("is self-contained: summary in the body, no repository link, the dashboard only as a labelled extra", async () => {
    const props = {
      documentTitle: "Raccolta dei Regolamenti Interni",
      deliberaLine: "Approvato dal Consiglio Direttivo il 08/10/2026",
      tag: "rri-v2026.10.08",
      attached: { official: "RaccoltaRegolamentiInterni.pdf", differences: "differenze-rri-v2026.10.08.pdf" },
      categories: [{ title: "Team e Team Lead", summary: "Il mandato dei Team Lead passa da uno a due anni." }],
      oppositionDeadline: "18/10/2026",
      dashboardUrl: "https://admin.polinetwork.org/dashboard/regulations/drafts/abc/diff",
    }
    const html = await render(<RegulationEmanatedEmail {...props} />)
    expect(html).toContain("Il mandato dei Team Lead passa da uno a due anni.")
    expect(html).toContain("RaccoltaRegolamentiInterni.pdf")
    expect(html).toContain("differenze-rri-v2026.10.08.pdf")
    expect(html).toContain("Per chi ha accesso alla dashboard di PoliNetwork")
    expect(html).not.toContain("github.com")
    const withoutDashboard = await render(<RegulationEmanatedEmail {...props} dashboardUrl={null} />)
    expect(withoutDashboard).not.toContain("dashboard")
  })
})
