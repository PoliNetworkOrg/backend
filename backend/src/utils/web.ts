import { logger } from "@/logger";
import { parse } from "node-html-parser";

export async function verifyTgLink(link: string): Promise<boolean> {
  const res = await fetch(link);
  const doc = await res.text();

  const root = parse(doc);
  if (
    !(root.querySelector("head > title")?.text === "Telegram: Join Group Chat")
  ) {
    logger.debug(`verifyTgLink: ${link} is not a valid tg invite link`)
    return false;
  }

  return (
    root
      .querySelector(".tgme_page_action")
      ?.querySelector("a")
      ?.classList.contains("tgme_action_button_new") ?? false
  );
}
