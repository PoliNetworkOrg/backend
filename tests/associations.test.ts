import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { commandSchema, profileSchema } from "@/associations/contract"
import { harness, outsider, owner, profile, staff } from "./associations-fixture"

describe("Association registry and scoped review", () => {
  it("registers an applicant without publishing or granting global permissions", async () => {
    const h = harness()
    const id = await h.registered()
    expect(await h.service.get(owner, id)).toMatchObject({
      registered: true,
      published: false,
      role: "responsible",
      operator: false,
    })
    await expect(h.service.get(outsider, id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await h.service.list(outsider)).associations).toEqual([])
  })
  it("registers an operator-created association without making the operator a representative", async () => {
    const h = harness()
    const { id } = await h.service.create(staff, {
      profile,
      explanation: "Register",
      submit: true,
      commandId: randomUUID(),
    })
    expect(await h.service.get(staff, id)).toMatchObject({
      registered: true,
      members: [],
      published: false,
      unrepresented: true,
    })
  })
  it("keeps the published version stable until a complete proposal is approved", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(owner, id, { action: "save", requestId: null, profile, explanation: "First publication" })
    const q = h.rows.get(id)!.requests.at(-1)!
    await h.command(owner, id, { action: "submit", requestId: q.id })
    await expect(
      h.command(owner, id, { action: "review", requestId: q.id, decision: "approve", reason: "Self approval" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.command(staff, id, { action: "review", requestId: q.id, decision: "approve", reason: "Approved" })
    await h.command(owner, id, {
      action: "save",
      requestId: null,
      profile: { ...profile, name: "Unapproved name" },
      explanation: "Rename",
    })
    expect((await h.service.get(owner, id)).publishedProfile?.name).toBe(profile.name)
    const next = h.rows.get(id)!.requests.at(-1)!
    await h.command(owner, id, { action: "submit", requestId: next.id })
    await h.command(staff, id, { action: "review", requestId: next.id, decision: "reject", reason: "Check the name" })
    expect((await h.service.get(owner, id)).publishedProfile?.name).toBe(profile.name)
  })
  it("requires acceptance and approval of the exact account, with single-use expiring invitations", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(owner, id, {
      action: "invite",
      role: "collaborator",
      email: "other@example.org",
      explanation: "New colleague",
    })
    const q = h.rows.get(id)!.requests.at(-1)!
    await expect(
      h.command(staff, id, { action: "review", requestId: q.id, decision: "approve", reason: "Not yet accepted" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const token = h.mails.at(-1)!.text.match(/token=([\w-]+)/)![1]
    expect(JSON.stringify(h.rows.get(id))).not.toContain(token)
    await h.service.accept(outsider, token)
    await expect(h.service.accept(owner, token)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await h.service.get(outsider, id)).role).toBeNull()
    await h.command(staff, id, { action: "review", requestId: q.id, decision: "approve", reason: "Identity verified" })
    expect((await h.service.get(outsider, id)).role).toBe("collaborator")
    await h.command(outsider, id, { action: "save", requestId: null, profile, explanation: "Edit" })
    await expect(
      h.command(outsider, id, { action: "submit", requestId: h.rows.get(id)!.requests.at(-1)!.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.command(outsider, id, {
        action: "invite",
        role: "responsible",
        email: "x@example.org",
        explanation: "Escalate",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("rejects expired and withdrawn invitations", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(owner, id, {
      action: "invite",
      email: "x@example.org",
      role: "responsible",
      explanation: "Successor",
    })
    const token = h.mails.at(-1)!.text.match(/token=([\w-]+)/)![1]
    h.rows.get(id)!.invitations[0].expiresAt = "2000-01-01T00:00:00Z"
    await expect(h.service.accept(outsider, token)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.command(owner, id, { action: "withdraw", requestId: h.rows.get(id)!.requests.at(-1)!.id })
    expect(h.rows.get(id)!.invitations).toEqual([])
  })
  it("hides internal notes and other applicants' evidence", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(staff, id, { action: "note", note: "PRIVATE" })
    await h.command(outsider, id, { action: "access", explanation: "SECRET EVIDENCE" })
    const own = JSON.stringify(await h.service.get(owner, id))
    const other = JSON.stringify(await h.service.get(outsider, id))
    expect(own).not.toContain("SECRET EVIDENCE")
    expect(own).not.toContain("PRIVATE")
    expect(other).not.toContain("PRIVATE")
    expect(JSON.parse(other).members).toEqual([])
    expect(JSON.stringify(await h.service.get(staff, id))).toContain("SECRET EVIDENCE")
  })
  it("requires a replacement before demoting the last responsible but allows explicit departure/revocation", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(owner, id, {
      action: "membership",
      sub: owner.sub,
      role: "collaborator",
      remove: false,
      explanation: "Hand over",
    })
    const requestId = h.rows.get(id)!.requests.at(-1)!.id
    await expect(
      h.command(staff, id, { action: "review", requestId, decision: "approve", reason: "Check" })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await h.command(staff, id, { action: "revoke", sub: owner.sub, reason: "Disputed representation" })
    expect((await h.service.get(staff, id)).unrepresented).toBe(true)
    await expect(
      h.command(owner, id, { action: "save", requestId: null, profile, explanation: "After revocation" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("suspends writes and archives publication without erasing history", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(staff, id, { action: "status", status: "suspended", hide: false, reason: "Check" })
    await expect(
      h.command(owner, id, { action: "save", requestId: null, profile, explanation: "Edit" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.command(staff, id, { action: "status", status: "archived", hide: true, reason: "Closed" })
    expect((await h.service.get(staff, id)).events.length).toBeGreaterThan(2)
    expect(await h.service.directory()).toEqual([])
  })
  it("rejects stale writes and makes retried commands idempotent", async () => {
    const h = harness()
    const id = await h.registered()
    const command = {
      id,
      revision: h.rows.get(id)!.revision,
      commandId: randomUUID(),
      action: "note" as const,
      note: "A",
    }
    await h.service.command(staff, command)
    await h.service.command(staff, command)
    expect(h.rows.get(id)!.revision).toBe(command.revision + 1)
    await expect(h.service.command(staff, { ...command, commandId: randomUUID(), note: "B" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })
  it("redirects duplicate registrations to a scoped access request without merging identities or granting roles", async () => {
    const h = harness()
    const destinationId = await h.registered()
    const { id } = await h.service.create(outsider, {
      profile,
      explanation: "Duplicate application",
      submit: true,
      commandId: randomUUID(),
    })
    await h.command(staff, id, {
      action: "redirect",
      requestId: h.rows.get(id)!.requests[0].id,
      destinationId,
      reason: "Already registered",
    })
    expect((await h.service.get(outsider, id)).requests[0].redirectId).toBe(destinationId)
    expect((await h.service.get(outsider, destinationId)).role).toBeNull()
    expect((await h.service.get(outsider, destinationId)).requests[0].kind).toBe("access")
  })
  it("validates safe links and bounded inputs", () => {
    expect(
      profileSchema.safeParse({ ...profile, links: [{ platform: "website", label: "X", url: "javascript:alert(1)" }] })
        .success
    ).toBe(false)
    expect(
      commandSchema.safeParse({
        action: "review",
        id: randomUUID(),
        revision: 0,
        commandId: randomUUID(),
        requestId: randomUUID(),
        decision: "approve",
        reason: "",
      }).success
    ).toBe(false)
  })
})
