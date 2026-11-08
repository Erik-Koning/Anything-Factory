"use client";
// Looking a code up, then approving or refusing it. The look-up is a form post, so a link from anywhere else can't
// spend the person's looks; a code asked for from another address than theirs is approved only by typing it again.
import { useActionState } from "react";
import { SubmitButton } from "../../../components/submit-button.tsx";
import { decideLinkAction, lookUpLinkAction } from "../actions.ts";

export function LinkMachine({ prefill }: { prefill: string }) {
  const [looked, look] = useActionState(lookUpLinkAction, { error: null, link: null, code: prefill });
  const [decided, decide] = useActionState(decideLinkAction, { error: null, code: "", gone: false });
  // What the decision said is about the code shown only.
  const said = looked.link && decided.code === looked.link.userCode ? decided : null;
  const link = said?.gone ? null : looked.link;
  const error = said?.gone ? said.error : looked.error;
  if (!link)
    return (
      <section className="panel stack" aria-labelledby="enter">
        <h2 id="enter">Enter the code your terminal shows</h2>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="hint">
          On the machine you want to see here, run <code>a6g connect app</code>. It shows a code and opens this page.
        </p>
        <form action={look} className="inline">
          <label>
            Code
            <input
              name="code"
              defaultValue={looked.code}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="BCDF-GHJK"
              maxLength={12}
              required
            />
          </label>
          <SubmitButton>Look it up</SubmitButton>
        </form>
      </section>
    );
  return (
    <section className="panel stack" aria-labelledby="waiting">
      <h2 id="waiting">Is this the code in your terminal?</h2>
      <p>
        <code className="key big">{link.userCode.replace(/^(.{4})/, "$1-")}</code>
      </p>
      <dl className="facts">
        <dt>Machine</dt>
        <dd>
          {link.name}
          {link.replaces ? `, linked again: it replaces your ${link.replaces}` : ""}
        </dd>
        <dt>Asked</dt>
        <dd>
          {link.ago} from {link.ip ?? "an unknown address"}
          {link.here ? ", the address you're on now" : ""}, by {link.device}
        </dd>
      </dl>
      {link.here ? (
        <p className="hint">
          Approve it only if you ran <code>a6g connect app</code> on that machine yourself, just now, and the code matches.
        </p>
      ) : (
        <p className="notice error" role="alert">
          This code was asked for from {link.ip ?? "an unknown address"}, not from the address you&apos;re on. If you didn&apos;t just run{" "}
          <code>a6g connect app</code> on a machine there yourself, someone may be trying to link their machine to your account: refuse it.
        </p>
      )}
      <p className="hint">
        Once linked it reports the teams it runs to your account, and nothing else: it can&apos;t see your teams, act as you or sign in. You&apos;ll get an
        email, and you can unlink it from Machines whenever you like.
      </p>
      {said?.error ? (
        <p className="notice error" role="alert">
          {said.error}
        </p>
      ) : null}
      <form action={decide} className="stack">
        <input type="hidden" name="code" value={link.userCode} />
        {link.here ? null : (
          <label>
            Type the code your terminal shows, to approve it
            <input name="typed" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="BCDF-GHJK" maxLength={12} />
          </label>
        )}
        <div className="inline">
          <SubmitButton className="primary" name="decision" value="approve">{`Link ${link.name} to my account`}</SubmitButton>
          <SubmitButton className="danger" name="decision" value="refuse">
            Refuse
          </SubmitButton>
        </div>
      </form>
    </section>
  );
}
