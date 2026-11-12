import {getAccessToken} from '../store/authStore';
import {prepareAccountLink,changeAccountLink,AccountLinkWriteError} from './accountLinks';
import {fetchProfileAccountLinks} from './serviceAccounts';

export class ProfileLinkController {
  busy = false;
  uncertain: {service: string; action: 'link'|'unlink'} | null = null;
  private token = getAccessToken();
  constructor(readonly actor: string, readonly user: string, private visible: () => boolean) {}
  current() { return this.visible() && !!this.token && this.token === getAccessToken(); }

  async change(service: string, action: 'link'|'unlink', confirm: () => boolean) {
    if (!this.current() || this.busy || this.uncertain) throw Error('Read current ownership before another change.');
    this.busy = true;
    try {
      const prepared = await prepareAccountLink(this.actor,this.user,service);
      if (!this.current()) throw Error('The selected profile changed.');
      if (!(action === 'link' ? prepared.can_link : prepared.can_unlink)) throw Error('This ownership change is unavailable. Refresh.');
      if (!confirm()) return null;
      if (!this.current()) throw Error('The selected profile changed.');
      return await changeAccountLink(prepared,action);
    } catch (error) {
      if (error instanceof AccountLinkWriteError && error.uncertain) this.uncertain = {service,action};
      throw error;
    } finally { this.busy = false; }
  }

  async reconcile() {
    if (!this.current() || this.busy || !this.uncertain) throw Error('No ownership review is available.');
    this.busy = true;
    try {
      const pair = await prepareAccountLink(this.actor,this.user,this.uncertain.service);
      const accounts = await fetchProfileAccountLinks(this.actor,this.user);
      if (!this.current() || pair.link_revision !== accounts.link_revision || pair.role_revision !== accounts.role_revision || pair.profile_revision !== accounts.profile_revision) throw Error('Ownership changed during the read. Read again.');
      const linked = accounts.linked_accounts.some(a => a.uuid === pair.service_uuid);
      if (linked !== pair.can_unlink) throw Error('Ownership reads disagree. Read again.');
      this.uncertain = null;
      return {accounts, linked};
    } finally { this.busy = false; }
  }
}
