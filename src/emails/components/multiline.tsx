import { Fragment } from "react"

export function Multiline({ children }: { children: string | null | undefined }) {
  return children?.split(/\r?\n/).map((line, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: Email lines are rendered once without state or reordering.
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ))
}
