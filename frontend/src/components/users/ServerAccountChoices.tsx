import {Link} from '@tanstack/react-router';
import {appLinks} from '../../router/appLinks';
export type ServerUsernameMatch={uuid:string;username:string;email:string|null;external_id:string};
export function ServerAccountChoices({server,username,matches}:{server:string;username:string;matches:readonly ServerUsernameMatch[]}) {
 return <div className="rounded-xl border bg-card p-6"><h2 className="text-xl font-semibold">Choose an account</h2><p className="mt-2 text-muted-foreground">More than one account on this server has the username {username}.</p><div className="mt-4 flex flex-col gap-2">{matches.map(match=><Link key={match.uuid} {...appLinks.serverUser(server,username)} search={{id:match.uuid}} className="rounded-lg border p-3 hover:bg-accent"><span className="font-semibold">{match.username}</span><span className="ml-3 text-sm text-muted-foreground">{match.email ? `${match.email} · ` : ''}Account {match.external_id || match.uuid}</span></Link>)}</div></div>;
}
