"""Regenerate Console observed-state goldens using real producer code from openkubes
1b0739f, a mocked Kubernetes client, and a synthetic 2 s step clock.

Usage: python3 bff/test-fixtures/regenerate-observed-state.py PRODUCER_DIR \
  bff/openKubesObservedState.fixtures.json EXTERNAL_OBSERVATIONS_CONFIGMAP
PRODUCER_DIR contains app.py from platform/console/observed-state-producer at
1b0739f. EXTERNAL_OBSERVATIONS_CONFIGMAP is its operator-observation ConfigMap
YAML (observations.json literal block). The input used in this repo is
deploy/kubernetes/overlays/ok-shared-live/producer-cluster-observations.yaml.
Uses only the Python standard library. Bypasses the producer constructor via
ObservedStateProducer.__new__ with injected config, tenants, client and clock;
only snapshot_v2 is real producer code. Patches Path.open during the snapshot.
No cluster is contacted. Output overwrites only the specified golden JSON.
"""
import json,sys,importlib.util,hashlib
from pathlib import Path
from datetime import datetime,timezone,timedelta
from unittest.mock import patch,mock_open
prod=Path(sys.argv[1]); overlay=Path(sys.argv[3]).read_text(); step=2
producer_sha256 = hashlib.sha256((prod/'app.py').read_bytes()).hexdigest()
assert producer_sha256 == 'e798f2dca87405ef9dfc93dd81c519396d5252f2ff678602304788261c8ccf39', 'Expected producer app.py from openkubes 1b0739f'
spec=importlib.util.spec_from_file_location('newprod',prod/'app.py'); m=importlib.util.module_from_spec(spec); sys.modules['newprod']=m; spec.loader.exec_module(m)
external=json.loads(overlay.split('observations.json: |\n',1)[1])
base=datetime(2026,10,22,12,0,0,tzinfo=timezone.utc)
observation=lambda:{
 'version':{'gitVersion':'v1.35.5+rke2r1'},
 'nodes':{'metadata':{'resourceVersion':'31461260'},'items':[{'status':{'conditions':[{'type':'Ready','status':'True'}]}}]},
 'deployment':{'metadata':{'resourceVersion':'31452633','generation':1},'spec':{'replicas':2},'status':{'observedGeneration':1,'availableReplicas':2}}}
wl={'metadata':{'name':'ok-console','namespace':'openkubes-console','resourceVersion':'31452633','generation':1},'spec':{'replicas':2},'status':{'observedGeneration':1,'availableReplicas':2}}
claims={'metadata':{'resourceVersion':'42'},'items':[{'metadata':{'name':'worker-east','resourceVersion':'43'},'spec':{'provider':'kubevirt','country':'fra-dc1','controlPlane':{'kubernetesVersion':'v1.34.1'}},'status':{'conditions':[{'type':'Ready','status':'True','lastTransitionTime':'2026-10-22T11:00:00Z'}]}}]}
t=[base]
def now(): return t[0]
class C:
  def read_hosting_cluster(self,ns,d): t[0]+=timedelta(seconds=step); return observation()
  def read_workload_deployment(self,ns,n): t[0]+=timedelta(seconds=step); return json.loads(json.dumps(wl))
  def list_cluster_claims(self,ns): t[0]+=timedelta(seconds=step); return json.loads(json.dumps(claims))
tenants={'management/ok-mgmt':'platform','hosting/ok-shared':'platform','claim/openkubes-system/worker-east':'platform','external/ok-ai':'platform','external/ok-infra':'platform'}
snapshots={}
for mode in ['hosting-cluster','hosting-external','kubevirt-claims']:
  t[0]=base
  config=m.ProducerConfig(source_mode='kubevirt-claims' if mode=='kubevirt-claims' else 'hosting-cluster',cluster_observations_file='observations.json' if mode=='hosting-external' else '',workload_deployments=('ok-console',))
  pr=m.ObservedStateProducer.__new__(m.ObservedStateProducer); pr.client=C(); pr.config=config; pr.now=now; pr.tenants=tenants
  with patch.object(m.Path,'open',mock_open(read_data=json.dumps(external).encode())):
    snapshots[mode]=pr.snapshot_v2()
output={'producerRevision':'1b0739f','producerSha256':producer_sha256,'snapshots':snapshots}
Path(sys.argv[2]).write_text(json.dumps(output,indent=2)+'\n')
print('Regenerated', ', '.join(snapshots), output['producerRevision'], output['producerSha256'])
