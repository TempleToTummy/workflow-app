// Tags, client groups and saved views — the rules behind organizing work.
// No framework, no database:
//
//   ./node_modules/.bin/tsx scripts/test-organize.ts
import {
  normalizeTagName,
  sameTagName,
  defaultTagColor,
  isTagColor,
  tagClasses,
  TAG_COLORS,
  MAX_TAG_LENGTH,
} from "../src/lib/tags";
import { matchesClientFilters, NO_GROUP } from "../src/lib/client-filters";
import {
  sanitizeViewQuery,
  normalizeViewName,
  isSavedViewPath,
  viewHref,
  MAX_VIEW_NAME_LENGTH,
} from "../src/lib/saved-views";
import { check, checkThrows, section, finish } from "./harness";

section("tag names");
check("trims and collapses whitespace", normalizeTagName("  Needs   1099s "), "Needs 1099s");
check("keeps the case people typed", normalizeTagName("VIP"), "VIP");
checkThrows("blank is refused", () => normalizeTagName("   "), "A tag needs a name.");
checkThrows("too long is refused", () => normalizeTagName("x".repeat(MAX_TAG_LENGTH + 1)));
check("same name ignoring case", sameTagName("vip", " VIP "), true);
check("different names", sameTagName("VIP", "VIPs"), false);

section("tag colours");
check("a name always gets the same colour", defaultTagColor("Late payer"), defaultTagColor("late PAYER"));
check("the default colour is a palette key", isTagColor(defaultTagColor("anything")), true);
check("unknown colour keys fall back to slate", tagClasses("javascript:alert(1)"), TAG_COLORS.slate);
check("known keys map to their classes", tagClasses("green"), TAG_COLORS.green);
check("isTagColor refuses non-strings", isTagColor(42), false);

section("group and tag filters");
const acme = { groupName: "Restaurants", tagIds: ["t-vip", "t-1099"] };
const solo = { groupName: null, tagIds: [] };
const blank = { groupName: "   ", tagIds: [] };
check("no filters match everything", matchesClientFilters(solo, {}), true);
check("group matches exactly", matchesClientFilters(acme, { group: "Restaurants" }), true);
check("a different group doesn't", matchesClientFilters(acme, { group: "Retail" }), false);
check("(No group) matches a client with none", matchesClientFilters(solo, { group: NO_GROUP }), true);
check("(No group) treats whitespace as none", matchesClientFilters(blank, { group: NO_GROUP }), true);
check("(No group) excludes grouped clients", matchesClientFilters(acme, { group: NO_GROUP }), false);
check("tag filter matches a carried tag", matchesClientFilters(acme, { tag: "t-vip" }), true);
check("tag filter excludes others", matchesClientFilters(solo, { tag: "t-vip" }), false);
check("group AND tag must both hold", matchesClientFilters(acme, { group: "Restaurants", tag: "t-none" }), false);
check("empty-string params are no filter", matchesClientFilters(solo, { group: "", tag: "" }), true);

section("saved views");
check("dashboard and tasks can hold views", [isSavedViewPath("/"), isSavedViewPath("/tasks")], [true, true]);
check("other pages can't", isSavedViewPath("/admin/employees"), false);
check("prototype keys are not paths", isSavedViewPath("toString"), false);
check(
  "keeps only the page's own filter keys, in a canonical order",
  sanitizeViewQuery("/", "status=DONE&evil=1&q=acme&clientId=c1"),
  "q=acme&clientId=c1&status=DONE"
);
check("tolerates a leading ?", sanitizeViewQuery("/tasks", "?due=overdue"), "due=overdue");
check("drops blank values", sanitizeViewQuery("/tasks", "q=&status=IN_PROGRESS"), "status=IN_PROGRESS");
check("drops over-long values", sanitizeViewQuery("/", `q=${"x".repeat(201)}`), "");
check("`view` is a dashboard key, not a tasks key", sanitizeViewQuery("/tasks", "view=completed"), "");
check(
  "the same filters in any order give the same string",
  sanitizeViewQuery("/", "tag=t1&group=Restaurants"),
  sanitizeViewQuery("/", "group=Restaurants&tag=t1")
);
check("an unencoded & ends the value, as in any query string", sanitizeViewQuery("/", "group=Smith & Sons"), "group=Smith");
check("encoded ampersands survive", sanitizeViewQuery("/", "group=Smith%20%26%20Sons"), "group=Smith+%26+Sons");
check("view name trimmed", normalizeViewName("  My   overdue  "), "My overdue");
checkThrows("blank view name refused", () => normalizeViewName(" "), "Give the view a name.");
checkThrows("long view name refused", () => normalizeViewName("x".repeat(MAX_VIEW_NAME_LENGTH + 1)));
check("href with a query", viewHref("/tasks", "due=overdue"), "/tasks?due=overdue");
check("href without one", viewHref("/", ""), "/");

finish();
