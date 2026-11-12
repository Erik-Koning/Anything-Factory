// The first name of whoever signed in last in this browser, for the sign-in page to greet them by. It's kept in the
// browser's own storage and nowhere else: never in a cookie, which would go to the server with every request. It
// stays after signing out, so that the next sign-in on this browser is greeted too.
const KEY = "a6g.first-name";
const LONGEST = 40;

export function rememberFirstName(name: string): void {
  const first = name.trim().split(/\s+/)[0]?.slice(0, LONGEST) ?? "";
  try {
    // Someone with no name signed in: the one before them isn't greeted in their place.
    if (first) window.localStorage.setItem(KEY, first);
    else window.localStorage.removeItem(KEY);
  } catch {
    // No storage here (it's turned off, or full): nobody is greeted.
  }
}

export function lastFirstName(): string | null {
  try {
    return window.localStorage.getItem(KEY)?.trim().slice(0, LONGEST) || null;
  } catch {
    return null;
  }
}
