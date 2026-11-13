"use client";
import { Fragment, useEffect, useState } from "react";

// A command to run in a terminal: mono, never wider than what holds it, and broken only at its spaces (each word is
// held whole, since a browser would otherwise break after the dash in --name), with a key that copies it. Where the
// browser won't let the page copy, the text is still there to select.
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
        {children.split(" ").map((word, index) => (
          <Fragment key={index}>
            {index ? " " : ""}
            <span className="word">{word}</span>
          </Fragment>
        ))}
      </code>
      <button type="button" className="quiet s" onClick={copy} aria-label={copied ? "Copied" : `Copy the command ${children}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
