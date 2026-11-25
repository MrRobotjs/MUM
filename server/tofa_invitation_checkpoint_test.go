package main

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"app/server/providers/tofa"
)

func TestTofaInvitationCheckpointKeepsRemoteIdentityOnRevocation(t *testing.T) {
	a, store := testApp(t)
	token, _ := bootstrapOwner(t,a)
	owner,err:=store.Authenticate(t.Context(),token); if err!=nil {t.Fatal(err)}
	serverID:=createManagedServer(t,a,token,"tofa","http://127.0.0.1:1")
	server,err:=a.loadServer(t.Context(),serverID);if err!=nil {t.Fatal(err)}
	now:=utcTimestamp(time.Now())
	activityExec(t,store,`INSERT INTO invites(token,created_at,updated_at,is_active,created_by_owner_id) VALUES('fixture-token',?,?,1,?)`,now,now,owner.ID)
	var inviteID int64
	if err=store.reader.QueryRow("SELECT id FROM invites WHERE token='fixture-token'").Scan(&inviteID);err!=nil {t.Fatal(err)}
	job:=newUUID()
	activityExec(t,store,`INSERT INTO provisioning_jobs(id,invite_id,user_uuid,status,created_at,updated_at,reservation_held) VALUES(?,?,?,'running',?,?,1)`,job,inviteID,owner.UUID,now,now)
	activityExec(t,store,`INSERT INTO provisioning_steps(job_id,server_id,status,grant_snapshot,server_revision,provider_fingerprint) VALUES(?,?,'pending','{}',?,?)`,job,serverID,server.Revision,providerFingerprint(server))
	key,err:=a.beginTofaInvitation(t.Context(),job,inviteID,server,"viewer@example.test")
	if err!=nil || key=="" {t.Fatal(key,err)}
	if _,err=a.beginTofaInvitation(t.Context(),job,inviteID,server,"viewer@example.test");!errors.Is(err,ErrConflict) {t.Fatal("duplicate send intent accepted",err)}
	activityExec(t,store,"UPDATE invites SET is_active=0 WHERE id=?",inviteID)
	remote:=tofa.OnboardingInvite{ID:"11234567-89ab-4cde-8fab-0123456789ab",Email:"viewer@example.test",State:"queued"}
	err=a.recordTofaInvitation(context.Background(),job,inviteID,server,remote)
	if !errors.Is(err,ErrConflict) {t.Fatal("revoked invite remained authorized",err)}
	var id,state string; var result sql.NullString
	if err=store.reader.QueryRow(`SELECT remote_invite_id,state,(SELECT remote_id FROM provisioning_steps WHERE job_id=? AND server_id=?) FROM tofa_invitation_receipts WHERE job_id=? AND server_id=?`,job,serverID,job,serverID).Scan(&id,&state,&result);err!=nil || id!=remote.ID || state!="queued" || result.Valid {t.Fatal(id,state,result,err)}
}
