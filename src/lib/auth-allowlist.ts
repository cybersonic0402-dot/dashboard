const ALLOWED_DOMAINS = ["zapply.nl", "codestrokes.com"];
const ALLOWED_EMAILS = ["sean@karlongroup.com"];

export function isAllowedEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  if (ALLOWED_EMAILS.includes(normalizedEmail)) return true;
  return ALLOWED_DOMAINS.some((domain) => normalizedEmail.endsWith(`@${domain}`));
}

export function getAllowedAccountsLabel() {
  return ["@zapply.nl", "@codestrokes.com", ...ALLOWED_EMAILS].join(", ");
}
