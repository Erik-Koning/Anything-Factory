// Who may see and do what, per role and team (server/access.ts): every page and server action asks there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Ability,
  blocked,
  can,
  canSeeRequest,
  decisionProblem,
  invitationProblem,
  pendingStep,
  LIMITS,
  requestProblem,
  roleIn,
  senderLabel,
  senderShort,
  taskIds,
  taskProblem,
  type Viewer,
  visibleTeams,
} from "../../server/access.ts";

const admin: Viewer = { userId: "u-admin", admin: true, secondFactor: true, twoFactor: true, ipConfirmed: true, teams: {} };
const adminWithoutSecondFactor: Viewer = { ...admin, secondFactor: false };
const member: Viewer = {
  userId: "u-member",
  admin: false,
  secondFactor: false,
  twoFactor: false,
  ipConfirmed: true,
  teams: { shop: "member", blog: "contributor" },
};
const contributor: Viewer = {
  userId: "u-contributor",
  admin: false,
  secondFactor: false,
  twoFactor: false,
  ipConfirmed: true,
  teams: { shop: "contributor" },
};

const TEAM_ABILITIES: Ability[] = [
  "team:overview",
  "team:board",
  "requests:all",
  "requests:send",
  "tasks:add",
  "tasks:suggest",
  "senders:names",
  "proposals:decide",
  "people:manage",
  "audit:read",
  "team:control",
];
const allowedOn = (viewer: Viewer | null, team?: string): Ability[] => TEAM_ABILITIES.filter((a) => can(viewer, a, team));

describe("an admin", () => {
  test("with the second factor does everything, on every team, members of it or not", () => {
    assert.deepEqual(allowedOn(admin, "shop"), TEAM_ABILITIES);
    assert.deepEqual(allowedOn(admin, "anything"), TEAM_ABILITIES);
    assert.equal(can(admin, "people:manage"), true);
    assert.equal(roleIn(admin, "shop"), "admin");
    assert.deepEqual(visibleTeams(admin, ["blog", "shop"]), ["blog", "shop"]);
  });

  test("without the second factor does nothing at all, and sees no team", () => {
    assert.equal(blocked(adminWithoutSecondFactor), true);
    assert.equal(pendingStep(adminWithoutSecondFactor), "second-factor");
    assert.deepEqual(allowedOn(adminWithoutSecondFactor, "shop"), []);
    assert.equal(can(adminWithoutSecondFactor, "people:manage"), false);
    assert.equal(roleIn(adminWithoutSecondFactor, "shop"), null);
    assert.deepEqual(visibleTeams(adminWithoutSecondFactor, ["blog", "shop"]), []);
    // Even a team they'd belong to as a member.
    assert.deepEqual(allowedOn({ ...adminWithoutSecondFactor, teams: { shop: "member" } }, "shop"), []);
  });
});

describe("a member", () => {
  test("sees the board, what's in progress, journeys, the graph and every request, sends requests and suggests tasks", () => {
    assert.deepEqual(allowedOn(member, "shop"), ["team:overview", "team:board", "requests:all", "requests:send", "tasks:suggest"]);
  });
  test("never adds tasks as the operator, sees names, decides proposals, manages people, pauses the team or reads the audit log", () => {
    assert.equal(can(member, "audit:read"), false);
    assert.equal(can(member, "audit:read", "shop"), false);
    for (const ability of ["tasks:add", "senders:names", "proposals:decide", "people:manage", "team:control"] as const)
      assert.equal(can(member, ability, "shop"), false, ability);
    assert.equal(can(member, "people:manage"), false);
  });
  test("is only what their role is on each team, and nothing on others", () => {
    assert.deepEqual(allowedOn(member, "blog"), ["team:overview", "requests:send"]);
    assert.deepEqual(allowedOn(member, "other"), []);
    assert.deepEqual(visibleTeams(member, ["blog", "other", "shop"]), ["blog", "shop"]);
  });
  test("a second factor changes nothing for someone who isn't an admin", () => {
    assert.deepEqual(allowedOn({ ...member, secondFactor: true }, "shop"), allowedOn(member, "shop"));
  });
});

describe("a contributor", () => {
  test("sees the overview and sends requests, nothing more", () => {
    assert.deepEqual(allowedOn(contributor, "shop"), ["team:overview", "requests:send"]);
    assert.equal(can(contributor, "team:board", "shop"), false);
    assert.equal(can(contributor, "requests:all", "shop"), false);
    assert.equal(can(contributor, "proposals:decide", "shop"), false);
    assert.equal(can(contributor, "tasks:suggest", "shop"), false);
    assert.equal(can(contributor, "tasks:add", "shop"), false);
  });
  test("sees their own requests only", () => {
    assert.equal(canSeeRequest(contributor, "shop", { from: "s4" }, "s4"), true);
    assert.equal(canSeeRequest(contributor, "shop", { from: "s5" }, "s4"), false);
    assert.equal(canSeeRequest(contributor, "shop", { from: null }, "s4"), false);
    // Without a stakeholder record on the team, none.
    assert.equal(canSeeRequest(contributor, "shop", { from: "s4" }, null), false);
    // Nor on a team they aren't on, whatever the ids.
    assert.equal(canSeeRequest(contributor, "blog", { from: "s4" }, "s4"), false);
  });
});

test("members and admins see every request of the team; nobody signed out sees any", () => {
  assert.equal(canSeeRequest(member, "shop", { from: "s9" }, null), true);
  assert.equal(canSeeRequest(admin, "shop", { from: "s9" }, null), true);
  assert.equal(canSeeRequest(null, "shop", { from: "s9" }, "s9"), false);
  assert.equal(canSeeRequest(adminWithoutSecondFactor, "shop", { from: "s9" }, null), false);
});

test("nobody signed out may do anything", () => {
  assert.deepEqual(allowedOn(null, "shop"), []);
  assert.deepEqual(visibleTeams(null, ["shop"]), []);
});

test("a team name that is an object's own key in JavaScript is just a team nobody is on", () => {
  for (const team of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(roleIn(member, team), null, team);
    assert.deepEqual(allowedOn(member, team), [], team);
  }
});

describe("who sent a request", () => {
  const sender = { id: "s3", name: "Ada Lovelace", email: "ada@example.com", role: "customer" };
  test("an admin sees the name and address", () => {
    assert.equal(senderLabel(admin, "shop", sender, null), "Ada Lovelace <ada@example.com> (customer)");
  });
  test("a member sees the role only", () => {
    assert.equal(senderLabel(member, "shop", sender, null), "customer");
  });
  test("the sender sees themselves", () => {
    assert.equal(senderLabel(contributor, "shop", sender, "s3"), "you");
  });
  test("an admin without the second factor sees no name", () => {
    assert.equal(senderLabel(adminWithoutSecondFactor, "shop", sender, null), "customer");
  });
  test("none at all", () => {
    assert.equal(senderLabel(admin, "shop", null, null), "no stakeholder");
  });
  test("on a card, shorter: the name to an admin, the role to anyone else, themselves as you, nothing for nobody", () => {
    assert.equal(senderShort(admin, "shop", sender, null), "Ada Lovelace");
    assert.equal(senderShort(member, "shop", sender, null), "customer");
    assert.equal(senderShort(contributor, "shop", sender, "s3"), "you");
    assert.equal(senderShort(member, "shop", null, null), null);
  });
});

describe("what's accepted", () => {
  test("a request has a title of at most 200 characters and a body of at most 20,000", () => {
    assert.match(requestProblem("", "") ?? "", /title/);
    assert.match(requestProblem("   ", "body") ?? "", /title/);
    assert.equal(requestProblem("a".repeat(LIMITS.title), "b".repeat(LIMITS.body)), null);
    assert.match(requestProblem("a".repeat(LIMITS.title + 1), "") ?? "", /200/);
    assert.match(requestProblem("ok", "b".repeat(LIMITS.body + 1)) ?? "", /20,000/);
  });
  test("an approval may come with a note; the other decisions need one", () => {
    assert.equal(decisionProblem("approve", ""), null);
    for (const d of ["reject", "research", "escalate"] as const) {
      assert.notEqual(decisionProblem(d, " "), null, d);
      assert.equal(decisionProblem(d, "because"), null, d);
    }
    assert.notEqual(decisionProblem("approve", "x".repeat(LIMITS.note + 1)), null);
  });
  test("an invitation names an address, a person, a team and a role", () => {
    const good = { email: "ada@example.com", name: "Ada", team: "shop", role: "contributor", label: "customer" };
    assert.equal(invitationProblem(good), null);
    assert.notEqual(invitationProblem({ ...good, email: "ada" }), null);
    assert.notEqual(invitationProblem({ ...good, name: "" }), null);
    assert.notEqual(invitationProblem({ ...good, team: "../x" }), null);
    assert.notEqual(invitationProblem({ ...good, role: "admin" }), null);
    assert.notEqual(invitationProblem({ ...good, label: "x".repeat(LIMITS.label + 1) }), null);
  });
  test("a task: a title, a kind, a severity for a suggested bug, a body that says what happened, and tasks it comes after", () => {
    const good = { title: "Pay does nothing", body: "Press Pay on the cart: nothing happens.", kind: "bug", severity: "major", after: "" };
    assert.equal(taskProblem(good, true), null);
    assert.match(taskProblem({ ...good, title: " " }, true) ?? "", /title/);
    assert.match(taskProblem({ ...good, severity: "" }, true) ?? "", /how bad/);
    assert.equal(taskProblem({ ...good, severity: "" }, false), null, "the operator's bug needn't say yet");
    assert.match(taskProblem({ ...good, severity: "awful" }, false) ?? "", /how bad/);
    assert.match(taskProblem({ ...good, body: "broken" }, true) ?? "", /sentence or two/);
    assert.equal(taskProblem({ ...good, body: "" }, false), null);
    assert.match(taskProblem({ ...good, kind: "journey" }, true) ?? "", /kind/, "a suggestion is never a journey");
    assert.equal(taskProblem({ ...good, kind: "journey" }, false), null);
    assert.match(taskProblem({ ...good, kind: "epic" }, false) ?? "", /kind/);
    assert.equal(taskProblem({ ...good, after: "3, #5 7" }, false), null);
    assert.match(taskProblem({ ...good, after: "3, five" }, false) ?? "", /by number/);
    assert.match(taskProblem({ ...good, after: Array.from({ length: 21 }, (_, i) => i + 1).join(",") }, false) ?? "", /at most 20/);
    assert.deepEqual(taskIds(" #3,5  5 "), ["3", "5"]);
    assert.equal(taskIds("0"), null);
  });
});

describe("a session that still owes a step", () => {
  test("from an IP address its person hasn't confirmed does nothing, admin or not, until it's confirmed", () => {
    for (const viewer of [admin, member, contributor]) {
      const away = { ...viewer, ipConfirmed: false };
      assert.equal(pendingStep(away), "confirm-ip", viewer.userId);
      assert.deepEqual(allowedOn(away, "shop"), [], viewer.userId);
      assert.equal(roleIn(away, "shop"), null, viewer.userId);
    }
  });
  test("with an authenticator turned on needs its code, then its address; without one, only its address", () => {
    const withAuthenticator = { ...member, twoFactor: true };
    assert.equal(pendingStep(withAuthenticator), "second-factor");
    assert.equal(pendingStep({ ...withAuthenticator, ipConfirmed: false }), "second-factor", "the code first, then the email");
    assert.equal(pendingStep({ ...withAuthenticator, secondFactor: true }), null);
    assert.equal(pendingStep({ ...withAuthenticator, secondFactor: true, ipConfirmed: false }), "confirm-ip");
    assert.equal(pendingStep(member), null, "no authenticator, no code asked for");
    assert.equal(pendingStep(null), null);
  });
});
