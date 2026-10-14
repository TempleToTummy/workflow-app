// Engagements: several independent copies of one project per client, and the
// project-level rule for who's responsible. No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-engagements.ts
import {
  engagementLabel,
  engagementHref,
  engagementKeyString,
  nextInstance,
  parseInstance,
  cleanEngagementName,
  projectRef,
  splitProjectRef,
  responsibleId,
} from "../src/lib/engagements";
import { threadKeyFor } from "../src/lib/email";
import { check, checkThrows, section, finish } from "./harness";

section("names");
check("the first copy is just the project", engagementLabel("Bookkeeping", null, 1), "Bookkeeping");
check("a second copy is numbered", engagementLabel("Bookkeeping", null, 2), "Bookkeeping 2");
check("a custom name wins", engagementLabel("Bookkeeping", "Client Bookkeeping 2", 2), "Client Bookkeeping 2");
check("…on the first copy too", engagementLabel("Bookkeeping", "Bookkeeping — Main LLC", 1), "Bookkeeping — Main LLC");
check("a blank name falls back", engagementLabel("Bookkeeping", "   ", 3), "Bookkeeping 3");
check("names are tidied", cleanEngagementName("  Bookkeeping   — Holding  LLC "), "Bookkeeping — Holding LLC");
check("blank means no custom name", cleanEngagementName(""), null);
checkThrows("absurdly long names are refused", () => cleanEngagementName("x".repeat(200)));

section("numbering");
check("first copy", nextInstance([]), 1);
check("second copy", nextInstance([1]), 2);
check("after a gap, the next number up", nextInstance([1, 3]), 4);
check("instance from the URL", [parseInstance("2"), parseInstance(undefined), parseInstance("0"), parseInstance("abc"), parseInstance("1.5")], [2, 1, 1, 1, 1]);

section("keys and links");
const one = { clientId: "c1", projectId: "p1", instance: 1 };
const two = { clientId: "c1", projectId: "p1", instance: 2 };
check("copies have different keys", engagementKeyString(one) === engagementKeyString(two), false);
check("a missing instance is the first copy", engagementKeyString({ clientId: "c1", projectId: "p1" }), engagementKeyString(one));
check("the first copy keeps the original link", engagementHref(one), "/assignments/c1/p1");
check("a second copy carries n", engagementHref(two), "/assignments/c1/p1?n=2");
check("…with tab and period", engagementHref(two, { tab: "files", period: "2026-10" }), "/assignments/c1/p1?n=2&tab=files&period=2026-10");
check("the list tab isn't spelled out", engagementHref(one, { tab: "list" }), "/assignments/c1/p1");
check("picker refs: first copy is the bare id", projectRef("p1", 1), "p1");
check("picker refs round-trip", splitProjectRef(projectRef("p1", 3)), { projectId: "p1", instance: 3 });
check("an old bare id is copy 1", splitProjectRef("p1"), { projectId: "p1", instance: 1 });
check("emails thread per copy", threadKeyFor({ clientId: "c1", projectId: "p1", periodName: "2026-10", instance: 2 }) === threadKeyFor({ clientId: "c1", projectId: "p1", periodName: "2026-10" }), false);
check("copy 1 threads exactly as before", threadKeyFor({ clientId: "c1", projectId: "p1", periodName: "2026-10", instance: 1 }), "eng:c1:p1:2026-10");

section("who's responsible (project level)");
check("the client's own owner for this copy", responsibleId({ defaultAssigneeId: "dana", project: { ownerId: "priya" } }), "dana");
check("else whoever handles the project", responsibleId({ defaultAssigneeId: null, project: { ownerId: "priya" } }), "priya");
check("else nobody", responsibleId({ defaultAssigneeId: null, project: { ownerId: null } }), null);

finish();
