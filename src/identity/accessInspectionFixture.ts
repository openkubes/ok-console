import type { AccessInspectionRow, ProjectRef, SubjectRef } from './accessInspection'

const project: ProjectRef = { tenantId: 'fixture-tenant', projectId: 'fixture-workspace' }
const user: SubjectRef = { kind: 'User', issuer: 'https://issuer.example.invalid', subject: 'fixture-user', displayName: 'Example user' }
const group: SubjectRef = { kind: 'Group', issuer: 'https://issuer.example.invalid', subject: 'fixture-group', displayName: 'Example group' }

/** Labelled fixture only: reachability is illustrative, with no observed evidence. */
export function readAccessInspectionFixture(): AccessInspectionRow[] {
  return [
    { id: 'fixture-proposed', source: 'fixture', subject: user, project, proposed: true, target: { clusterId: 'fixture-cluster-a', namespace: 'fixture-app', namespaceUid: 'fixture-uid-app' } },
    { id: 'fixture-unverified', source: 'fixture', subject: group, project, clusterReachable: true, target: { clusterId: 'fixture-cluster-a', namespace: 'fixture-app', namespaceUid: 'fixture-uid-app' } },
    { id: 'fixture-unknown', source: 'fixture', subject: group, project, target: { clusterId: 'fixture-cluster-a', namespace: 'fixture-jobs', namespaceUid: 'fixture-uid-jobs' } },
    { id: 'fixture-unreachable', source: 'fixture', subject: group, project, clusterReachable: false, target: { clusterId: 'fixture-cluster-b', namespace: 'fixture-review', namespaceUid: 'fixture-uid-review' } },
  ]
}
