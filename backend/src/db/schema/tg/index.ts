import * as groups from "./groups";
import * as test from "./test";
import * as permissions from "./permissions";
import * as link from "./link";
import * as messages from "./messages";

export const schema = { ...groups, ...test, ...permissions, ...link, ...messages };
