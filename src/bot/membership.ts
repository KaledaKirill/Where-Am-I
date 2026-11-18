import type { Api } from 'grammy';

export async function isGroupMember(api: Pick<Api, 'getChatMember'>, groupId: string, userId: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const member = await api.getChatMember(groupId, userId);
  return ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member);
}
