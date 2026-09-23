/**
 * Automation this platform will never perform, regardless of configuration,
 * autonomy level or owner request. Enforced by lib/agents/permissions.ts
 * (capabilities can never be granted) and referenced by adapters/UI.
 */
export const PROHIBITED_AUTOMATION = {
  mass_dm: 'Sending direct messages in bulk',
  unsolicited_dm: 'Messaging people who have not contacted the character first',
  follow_unfollow: 'Automated follow/unfollow or growth-hacking actions',
  fake_engagement: 'Buying, faking or coordinating likes, comments, views or followers',
  engagement_pods: 'Coordinated engagement groups',
  rate_limit_evasion: 'Evading platform rate limits (proxies, account rotation, jitter tricks)',
  account_rotation: 'Operating multiple accounts to evade limits or bans',
  deceptive_impersonation: 'Impersonating a real person or presenting the AI character as human',
  undisclosed_sponsorship: 'Publishing sponsored content without disclosure',
  private_data_scraping: 'Collecting personal data such as private emails or phone numbers',
} as const

export type ProhibitedAutomation = keyof typeof PROHIBITED_AUTOMATION

export function isProhibited(action: string): action is ProhibitedAutomation {
  return Object.prototype.hasOwnProperty.call(PROHIBITED_AUTOMATION, action)
}
