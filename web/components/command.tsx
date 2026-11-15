"use client";
import { Fragment, useEffect, useState } from "react";

// A command's parts, each kept on one line: a new one starts at a joiner (&&, ||, |, ;) and at a flag (--name, with
// its value), so a long command breaks where a person would break it and never part-way through "npm install".
function parts(command: string): string[] {
  const out: string[] = [];
  for (const word of command.split(" ")) {
    if (!out.length || /^(&&|\|\||\||;)$/.test(word) || word.startsWith("--")) out.push(word);
    else out[out.length - 1] += ` ${word}`;
  }
  return out;
}

// A command to run in a terminal: mono, never wider than what holds it, broken between its parts (each part is held
// together as one box, which breaks at its own spaces only when it is wider than the block, and each word is held
// whole, since a browser would otherwise break after the dash in --name), with a key that copies it. Where the browser
// won't let the page copy, the text is still there to select.
export function Command({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
    } catch {}
  };
  return (
    <span className="command">
      <code>
        {parts(children).map((part, index) => (
          <Fragment key={index}>
            {index ? " " : ""}
            <span className="part">
              {part.split(" ").map((word, at) => (
                <Fragment key={at}>
                  {at ? " " : ""}
                  <span className="word">{word}</span>
                </Fragment>
              ))}
            </span>
          </Fragment>
        ))}
      </code>
      <button type="button" className="quiet s" onClick={copy} aria-label={copied ? "Copied" : `Copy the command ${children}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
