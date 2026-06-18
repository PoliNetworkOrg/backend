import * as associations from "./associations"
import * as faqs from "./faqs"
import * as projects from "./projects"
import * as test from "./test"

export const schema = { ...associations, ...test, ...faqs, ...projects }
