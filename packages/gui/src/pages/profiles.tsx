/**
 * The persona roster, and how to get into the app as one of them.
 *
 * The credentials were only ever printed by `mocktown profiles list`, so someone looking at
 * a running mock in a browser had no way to find the password it would accept. They are
 * mock credentials for a mock service — hiding them protects nothing and costs the one
 * thing this screen exists to give.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { useProfiles, useStatus } from '../hooks.ts';
import { Badge, Button, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

const SIGN_IN: Record<string, { tone: 'good' | 'warn' | 'plain'; hint: string }> = {
  credentials: { tone: 'good', hint: 'Sign in through the app with the credentials below.' },
  'consent-picker': { tone: 'warn', hint: 'Emulator-backed: pick this account in the consent screen; there is no password.' },
  'token-only': { tone: 'plain', hint: 'No credentials at all. Mint a token, or stay signed out.' },
};

export function Profiles({ project }: { project: string }) {
  const profiles = useProfiles(project);
  const status = useStatus(project);
  const [minted, setMinted] = useState<{ profile: string; header: string } | null>(null);

  const session = useMutation({
    mutationFn: (name: string) => api.profiles.session({ project, name }),
    onSuccess: (result) => setMinted({ profile: result.profile, header: result.header }),
  });

  if (profiles.error) return <Failure error={profiles.error} />;
  if (!profiles.data) return <Pending what="the roster" />;

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Profiles — ${profiles.data.profiles.length}`}>
        {profiles.data.profiles.length === 0 ? (
          <Empty>No profiles. `mocktown profiles set` adds one.</Empty>
        ) : (
          <Table head={['profile', 'sign-in', 'credentials', 'how it differs', '']}>
            {profiles.data.profiles.map((profile) => {
              const kind = SIGN_IN[profile.signIn] ?? SIGN_IN['token-only']!;
              const credentials = Object.entries(profile.credentials);
              return (
                <tr key={profile.name}>
                  <Cell mono>{profile.name}</Cell>
                  <Cell>
                    <Badge tone={kind.tone}>{profile.signIn}</Badge>
                  </Cell>
                  <Cell mono>
                    {credentials.length === 0 ? (
                      <Muted>—</Muted>
                    ) : (
                      credentials.map(([field, value]) => (
                        <div key={field}>
                          <Muted>{field}</Muted> {value}
                        </div>
                      ))
                    )}
                  </Cell>
                  <Cell>{profile.description}</Cell>
                  <Cell>
                    <Button onClick={() => session.mutate(profile.name)} disabled={session.isPending}>
                      mint token
                    </Button>
                  </Cell>
                </tr>
              );
            })}
          </Table>
        )}
        {session.error && (
          <div className="mt-2">
            <Failure error={session.error} />
          </div>
        )}
      </Card>

      {minted && (
        <Card title={`Authorization header for ${minted.profile}`}>
          {/* The point of minting is skipping the login UI entirely, so what is shown is the
              header value itself rather than the token it wraps. */}
          <pre className="overflow-x-auto rounded border border-line bg-base p-2 font-mono text-[12px]">{minted.header}</pre>
          <p className="mt-2">
            <Muted>Send this as `Authorization` to call the mocks directly, with no sign-in.</Muted>
          </p>
        </Card>
      )}

      <Card title="Signing in through the app">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Open{' '}
            {status.data?.appUrl ? (
              <a className="font-mono text-good underline underline-offset-2" href={status.data.appUrl} target="_blank" rel="noreferrer">
                {status.data.appUrl}
              </a>
            ) : (
              <Muted>the app — set `app.url` in mocktown.json to have it linked here</Muted>
            )}
            , started with the variables from the Addresses tab.
          </li>
          <li>Sign in with a profile's credentials above. Each profile is a different shape of account, not a different password.</li>
          <li>
            A profile whose sign-in is <span className="font-mono">token-only</span> has nothing to type — mint a token instead.
          </li>
        </ol>
      </Card>
    </div>
  );
}
