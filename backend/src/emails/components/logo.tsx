import { Img, Section } from "@react-email/components"

export function Logo() {
  return (
    <Section className="py-7 sm:py-10 text-center">
      <Img
        src="https://raw.githubusercontent.com/PoliNetworkOrg/Logo/a1e02bf150ac0b3c734a629901eada79fb4fd762/Logo.svg"
        alt="PoliNetwork APS Logo"
        className="mx-auto block w-24 h-24 sm:w-32 sm:h-32"
      />
    </Section>
  )
}
