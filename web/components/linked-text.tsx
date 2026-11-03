import Link from "next/link";

// Text as the team wrote it, with each "#21" that names a task of the team linked to that task's page.
export function LinkedText({ text, base, titles }: { text: string; base: string; titles: ReadonlyMap<string, string> }) {
  const parts = text.split(/(#[1-9]\d{0,8}\b)/);
  return (
    <>
      {parts.map((part, i) => {
        const id = part.startsWith("#") ? part.slice(1) : "";
        const title = id ? titles.get(id) : undefined;
        return title !== undefined ? (
          <Link key={i} href={`${base}/tasks/${id}`} title={title}>
            {part}
          </Link>
        ) : (
          part
        );
      })}
    </>
  );
}
