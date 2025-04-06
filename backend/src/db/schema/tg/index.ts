import * as groups from "./groups";
import * as test from "./test";
import * as permissions from "./permissions";

export const schema = { ...groups, ...test, ...permissions };
