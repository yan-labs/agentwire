export type RecipientMember = { id: string; name: string };

export type WakeMessage = {
  from: string;
  to: string | null;
  recipients?: string[];
};

export function resolveRecipient(value: string, members: RecipientMember[]): string {
  const id = members.find((m) => m.id === value);
  if (id) return id.id;
  const matches = members.filter(
    (m) => m.name.normalize("NFC").toLowerCase() === value.normalize("NFC").toLowerCase()
  );
  if (!matches.length) throw new Error("unknown recipient");
  if (matches.length !== 1) throw new Error("ambiguous recipient; use agent_id");
  return matches[0].id;
}

export function mentionedRecipients(text: string, members: RecipientMember[], sender: string): string[] {
  let fence: string | null = null;
  let quote = false;
  let prose = text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
        return "";
      }
      if (marker) {
        fence = marker;
        return "";
      }
      if (!line.trim()) quote = false;
      if (/^ {0,3}>/.test(line)) quote = true;
      if (quote || /^(?: {4}|\t)/.test(line)) return "";
      return line;
    })
    .join("\n")
    .replace(/<!--[^]*?(?:-->|$)|<(code|pre|blockquote)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, " ");
  let plain = "",
    offset = 0;
  for (const run of prose.matchAll(/`+/g)) {
    if (run.index! < offset) continue;
    plain += prose.slice(offset, run.index) + " ";
    const end = new RegExp("(?<!`)`{" + run[0].length + "}(?!`)", "g");
    end.lastIndex = run.index! + run[0].length;
    const closing = end.exec(prose);
    offset = closing ? closing.index + closing[0].length : prose.length;
  }
  prose = (plain + prose.slice(offset)).replace(
    /"[^"]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|(?<![\p{L}\p{N}])'[^']*(?:'|$)/gmu,
    " "
  );
  const ids = new Set<string>();
  for (const match of prose.matchAll(/(?<![\p{L}\p{M}\p{N}\p{Cf}\p{Pc}\p{Pd}@.+/\\．․])@([\p{L}\p{M}\p{N}\p{Cf}\p{Pc}\p{Pd}.．․]+)/gu)) {
    const candidate = match[1].replace(/(?<!\.)\.$/u, "");
    if (!/^[\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*$/u.test(candidate)) continue;
    if (candidate.toLowerCase() === "all") {
      for (const member of members) if (member.id !== sender) ids.add(member.id);
      continue;
    }
    try {
      const id = resolveRecipient(candidate, members);
      if (id !== sender) ids.add(id);
    } catch {
      /* unknown or ambiguous @mention is ignored */
    }
  }
  return [...ids];
}

export function wakes(message: WakeMessage, id: string | null | undefined): boolean {
  return !!id && message.from !== id && (message.recipients ?? (message.to ? [message.to] : [])).includes(id);
}
