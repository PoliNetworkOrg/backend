import * as faqs from "./faqs"
import * as projects from "./projects"
import * as test from "./test"

export const schema = { ...test, ...faqs, ...projects }
