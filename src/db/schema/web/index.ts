import * as associations from "./associations"
import * as faqs from "./faqs"
import * as groupLinkReports from "./group-link-reports"
import * as guides_matricole from "./guides_matricole"
import * as projects from "./projects"
import * as test from "./test"

export const schema = { ...associations, ...test, ...faqs, ...projects, ...guides_matricole, ...groupLinkReports }
