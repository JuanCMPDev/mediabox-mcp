/**
 * Validates the comma-separated Telegram user-ID list collected by the wizard.
 *
 * When the bot is enabled we require at least one numeric ID so the generated
 * .env never ships an empty ALLOWED_TELEGRAM_USERS — which the bot treats as
 * "allow everyone". This prompt is only shown when the bot is enabled, so the
 * requirement never blocks users who leave Telegram off.
 */
export function validateAllowedTelegramUsers(val: string): true | string {
  const ids = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return "Enter at least one Telegram user ID (get yours from @userinfobot)";
  }
  if (!ids.every((id) => /^\d+$/.test(id))) {
    return "User IDs must be numeric, comma-separated (e.g. 12345678, 87654321)";
  }
  return true;
}
