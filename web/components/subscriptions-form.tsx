"use client";
import { useState } from "react";
import { subscriptionsAction } from "../app/t/[team]/actions.ts";
import { SubmitButton } from "./submit-button.tsx";
import { SubscriptionOrder } from "./subscription-order.tsx";
import type { SubscriptionOption } from "./subscription-words.ts";

const plural = (role: string): string => (role === "planner" ? "planner" : `${role}s`);
// "planner, builders and reviewers".
const listed = (names: string[]): string => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

// The form that sets what a team runs on: every role's order, or one role's own. The list shown follows the choice of
// role, starting from what that one has now, and the line under the choice says what the change leaves alone: a role
// with an order of its own keeps it when every role's is changed.
export function SubscriptionsForm({
  team,
  roles,
  options,
  use,
}: {
  team: string;
  roles: string[];
  options: SubscriptionOption[];
  // What the operator listed so far: "*" for every role, or a role's own.
  use: Record<string, string[]>;
}) {
  const [role, setRole] = useState("");
  const own = roles.filter((r) => use[r]?.length);
  const followers = roles.filter((r) => !own.includes(r));
  return (
    <form action={subscriptionsAction} className="stack">
      <input type="hidden" name="team" value={team} />
      <div className="field">
        <label htmlFor="subscriptions-role">Whose order</label>
        <select
          id="subscriptions-role"
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          aria-describedby="subscriptions-role-hint"
        >
          {/* Named for what it sets: where a role has an order of its own, this one isn't every role's. */}
          <option value="">{own.length ? `The ${listed(followers.map(plural))}` : "Every role"}</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              Only the {plural(r)}
              {use[r]?.length ? " (their own)" : ""}
            </option>
          ))}
        </select>
        <p id="subscriptions-role-hint" className="hint">
          {role
            ? use[role]?.length
              ? `This replaces the ${plural(role)}' own order. With none chosen, they go back to following the team's.`
              : `The ${plural(role)} follow the team's order now. An order chosen here is theirs alone.`
            : own.length
              ? `The ${listed(own.map(plural))} keep their own order (${own.map((r) => (use[r] ?? []).join(", then ")).join("; ")}). To change that, choose them above.`
              : "Every role follows this order."}
        </p>
      </div>
      <fieldset className="choices">
        <legend>New order</legend>
        <SubscriptionOrder
          key={role}
          options={options}
          initial={use[role || "*"] ?? []}
          empty={role ? `the ${plural(role)} follow the team's order` : "the team runs on its Mac's own login, which nothing watches"}
        />
      </fieldset>
      <p className="hint">
        A role moves once none of its agents is working, so a change can take a few minutes to show. The planner starts a fresh thread on its new
        subscription.
      </p>
      <div className="field">
        <label htmlFor="subscriptions-code">
          <span>
            Code from your authenticator <span className="optional">6 digits</span>
          </span>
        </label>
        <div className="code-row">
          <input
            id="subscriptions-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            className="code six"
          />
          <SubmitButton className="primary">Save this order</SubmitButton>
        </div>
      </div>
    </form>
  );
}
