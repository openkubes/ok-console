# OpenKubes AI Thinkerers – Live Demo Runbook

**Version:** 1.0 – Düsseldorf Live Demo
**Datum:** 25. November 2026, 18:00 Uhr
**Repository:** `openkubes/ok-console`
**Ursprünglicher Demo-Branch:** `demo/ai-thinkers-live`
**Ursprünglich dokumentierter Validierungsstand:** `01285df`
**Archivierter Konferenzstand:** `4f172a4`
**Git-Tag:** `ai-tinkerers-duesseldorf-2026`
**Umgebung:** macOS / Colima / kind Kubernetes v1.37.0 / Ollama

> **Scope:** Lokaler, experimenteller MVP auf einem disposable kind-Cluster. Keine produktionsreife HOTL-Autorisierung, keine signierte Evidence. Die Kubernetes-Ressourcen heißen technisch weiterhin `kind-wjax-demo`, `wjax-demo` und `wjax-nginx`.

## 1. Ziel der Demo

Zwei Betriebsmodelle AI-gestützter Kubernetes-Automatisierung demonstrieren:

- **HITL (Human in the Loop):** AI generates a proposal → Policy evaluates → Human approves → OpenKubes executes → Evidence verifies.
- **HOTL (Human on the Loop):** Kubernetes drift detected → AI proposes → Deterministic policy checks → Pre-authorized execution → Recovery verified → Human oversight.

## 2. Architektur und lokale Endpunkte

| Komponente | URL / Identität |
|---|---|
| OpenKubes Console | <http://127.0.0.1:8790/#/wjax> |
| AI Thinkerers HITL | <http://127.0.0.1:8788/> |
| AI Thinkerers HOTL | <http://127.0.0.1:8794/> |
| Kubernetes Reader | Port 8791 |
| Diagnostics | Port 8793 |
| Ollama | Port 11434 |
| Kubernetes Context | `kind-wjax-demo` |
| Namespace | `wjax-demo` |
| Deployment | `wjax-nginx` |
| Modell | `llama3.2:latest` |

Die Console zeigt die Präsentationsnamen „AI Thinkerers Demo“, „AI Thinkerers Lab“ und „AI Thinkerers nginx“. Das sind **Anzeigenamen**, keine geänderten Kubernetes-Identitäten.

## 3. Preflight vor dem Auftritt

### 3.1 Repository prüfen

```bash
cd ~/temp/kubernauts/ok/ok-console

git branch --show-current
git rev-parse --short HEAD
git status --short
```

Erwartet: Branch `demo/ai-thinkers-live`, Commit `01285df`, leeres `git status --short`. **Kein Git-Pull, Merge oder Commit auf dem eingefrorenen Demo-Stand.**

### 3.2 Umgebung setzen

Die Variablen müssen in **jedem neuen Terminal** gesetzt werden, das sie verwendet:

```bash
cd ~/temp/kubernauts/ok/ok-console
export DOCKER_CONTEXT=colima
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"
```

### 3.3 Kubernetes und Ollama prüfen

```bash
docker info >/dev/null && echo "Docker OK"
kubectl --context kind-wjax-demo get nodes
kubectl --context kind-wjax-demo -n wjax-demo get deploy wjax-nginx
curl -fsS http://127.0.0.1:11434/api/tags
ollama list
```

Erwartet: Control Plane `Ready`, `wjax-nginx` **2/2**, Ollama erreichbar und `llama3.2:latest` vorhanden. **Den Cluster nicht neu erstellen oder das Deployment löschen.**

### 3.4 Basisservices prüfen

```bash
make wjax-demo-status
```

Erwartet:

```text
console     http=OK
demo        http=OK
reader      http=OK
diagnostics http=OK
```

Falls die Services nicht laufen:

```bash
make wjax-demo-check && make wjax-demo && make wjax-demo-status
```

Bei abgelaufenen ServiceAccount-Tokens `make wjax-demo-auth` gezielt ausführen, danach erneut Preflight und Status prüfen. Dies rotiert temporäre Demo-Credentials.

### 3.5 Diagnostics prüfen

```bash
make wjax-demo-diagnose
```

Erwartet:

```text
ADR-021 local diagnostics (healthy subject + foreign workload rejection): PASS
```

## 4. Browser vorbereiten

Drei Tabs öffnen:

1. **Console:** <http://127.0.0.1:8790/#/wjax> – Read-only Kubernetes Live View und **Refresh observation**.
2. **HITL:** <http://127.0.0.1:8788/> – Intent, Proposal, Policy, Human Approval, Execution.
3. **HOTL:** <http://127.0.0.1:8794/> – Recovery Sequence und Evidence Timeline.

Falls das HOTL-Dashboard nicht läuft, in einem separaten Terminal starten:

```bash
cd ~/temp/kubernauts/ok/ok-console
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"
python3 demos/ai-thinkers/dashboard.py --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

Das Dashboard ist **read-only** und startet keinen Supervisor. Dieses Terminal offen lassen. **Nicht** mehrfach auf Port 8794 starten.

## 5. Demo A – HITL (Human in the Loop)

**Voraussetzung:** nginx `2/2`. Kein HOTL-Supervisor darf parallel aktiv sein, sonst würde er den Incident automatisch beheben und die HITL-Demonstration stören.

### A1 – Incident simulieren

```bash
kubectl --context kind-wjax-demo -n wjax-demo \
  scale deploy/wjax-nginx --replicas=0
```

In der Console **Refresh observation** anklicken; nginx zeigt `0/0`.

### A2 – AI Proposal

Im HITL-Tab:

```text
Deploy nginx with two replicas to the demo cluster
```

**Generate candidate** anklicken. Erwarteter Vorschlag:

```json
{
  "operation": "deploy",
  "workload": "nginx",
  "replicas": 2,
  "target": "demo"
}
```

Policy muss den Vorschlag für **explizite menschliche Freigabe** zulassen.

### A3 – Human Approval

**Approve exact proposal** anklicken. Die Demo bindet die Freigabe an den Proposal-Digest.

### A4 – Ausführung

**Execute authorized operation** anklicken. Anschließend **Refresh live status** bzw. **Refresh observation** verwenden und nginx `2/2` beobachten.

### A5 – Unabhängige Verifikation

```bash
kubectl --context kind-wjax-demo -n wjax-demo \
  rollout status deploy/wjax-nginx --timeout=90s
make wjax-demo-verify
```

Erwartet: `RECOVERY_VERIFIED`, `READY_VERIFIED`, `desired=2`, `ready=2`, `available=2`.

**Achtung:** Der HITL-Verifier benötigt passende `HUMAN_APPROVED`- und `EXECUTOR_APPLIED`-Ereignisse der aktuellen HITL-Session. Eine manuelle Skalierung allein zählt nicht. Wenn bereits historische Evidence existiert, die Ausgabe sorgfältig auf `ALREADY_VERIFIED` bzw. die passende Session prüfen. Nicht an Evidence-Dateien manipulieren.

### A6 – Policy-DENY (optional)

Auf **Try forbidden production request** klicken. Erwartet: `TARGET_NOT_ALLOWED`. Es darf keine Produktionsänderung ausgelöst werden.

## 6. Demo B – HOTL (Human on the Loop)

**Voraussetzung:** nginx `2/2`; HITL-Demo abgeschlossen. HOTL ist nur für die vorab definierte Replica-Recovery auf dem lokalen kind-Cluster zulässig.

### B1 – Supervisor explizit starten (Terminal A)

```bash
cd ~/temp/kubernauts/ok/ok-console
export DOCKER_CONTEXT=colima
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"
export AI_THINKERS_HOTL=I_ACCEPT_LOCAL_KIND_ONLY

python3 demos/ai-thinkers/hotl.py \
  --enable-hotl \
  --once \
  --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

Erwartet:

```text
HOTL_ENABLED
AI Thinkerers HOTL: watching. Ctrl-C stops future actions.
```

Das Dashboard sollte für die **neueste Session** zunächst `AWAITING DRIFT` anzeigen. Keinen zweiten Supervisor parallel starten.

### B2 – Incident auslösen (Terminal B)

```bash
kubectl --context kind-wjax-demo -n wjax-demo \
  scale deploy/wjax-nginx --replicas=0
```

**Keinen manuellen Approval-Button drücken.**

### B3 – Automatische Recovery beobachten

Die HOTL-Timeline soll die folgenden Ereignisse in Reihenfolge protokollieren:

1. `HOTL_ENABLED`
2. `DRIFT_CONFIRMED`
3. `AI_PROPOSAL`
4. `HOTL_EXECUTED`
5. `HOTL_RECOVERY_VERIFIED`

Der LLM-Vorschlag ist **keine Autorisierung**; die lokale deterministische Logik beschränkt die Ausführung auf einen atomaren Patch `replicas: 0 → 2` nach UID-/Generation-/ResourceVersion-Prüfungen.

### B4 – Kubernetes zusätzlich kontrollieren

```bash
kubectl --context kind-wjax-demo -n wjax-demo \
  get deploy wjax-nginx
```

Erwartet: `2/2` und im Dashboard `READY VERIFIED`.

Die HOTL-Readiness-Prüfung nutzt derzeit dieselbe begrenzte Executor-Identität und ist **keine unabhängige oder kryptographisch gesicherte Verifikation**. Der HITL-Verifier `make wjax-demo-verify` ist für diese HOTL-Session nicht geeignet, da es hier absichtlich kein `HUMAN_APPROVED`-Event gibt.

## 7. Negativtest – HOTL ohne Opt-in

**Erst nach Beendigung des laufenden `--once`-Supervisors:**

```bash
cd ~/temp/kubernauts/ok/ok-console
export WJAX_DEMO_RUNTIME_DIR="/path/to/your/private/wjax-runtime"

env -u AI_THINKERS_HOTL \
  python3 demos/ai-thinkers/hotl.py \
  --enable-hotl \
  --once \
  --runtime-dir "$WJAX_DEMO_RUNTIME_DIR"
```

Erwartete Ablehnung:

```text
HOTL disabled; require --enable-hotl and explicit AI_THINKERS_HOTL consent
```

Der Fehlercode ist hier das **gewünschte PASS-Ergebnis**.

## 8. Notfallplan / Fallback

### 8.1 Ollama nicht erreichbar

```bash
curl -fsS http://127.0.0.1:11434/api/tags
ollama list
open -a Ollama
```

Wenn Ollama weiterhin nicht funktioniert: keine AI-Recovery behaupten; stattdessen Architektur/Console erläutern.

### 8.2 nginx bleibt bei 0/0

Zuerst laufenden HOTL-Supervisor mit `Ctrl+C` stoppen. Danach **nur im lokalen Demo-Cluster** manuell wiederherstellen:

```bash
kubectl --context kind-wjax-demo -n wjax-demo \
  scale deploy/wjax-nginx --replicas=2
kubectl --context kind-wjax-demo -n wjax-demo \
  rollout status deploy/wjax-nginx --timeout=120s
```

**Manuelle Recovery transparent als manuell bezeichnen**, nicht als HOTL-Erfolg.

### 8.3 HOTL-Dashboard nicht erreichbar

```bash
curl -fsS http://127.0.0.1:8794/api/events
```

Bei `Address already in use` den bestehenden Prozess ermitteln. Keinen zweiten Dashboard-Prozess parallel auf Port 8794 starten.

### 8.4 Console nicht erreichbar

```bash
make wjax-demo-status
```

Falls Basisservices ausgefallen sind:

```bash
make wjax-demo-stop
make wjax-demo-check && make wjax-demo && make wjax-demo-status
```

Port 8794 und der HOTL-Supervisor gehören **nicht** zu den vier durch `make wjax-demo-status` geprüften Basisservices.

## 9. Validierte Ergebnisse vor der Demo

| Prüfung | Ergebnis |
|---|---|
| HOTL E2E #1 | PASS |
| HOTL E2E #2 | PASS |
| HOTL Unit-Tests | 6/6 PASS |
| HOTL Opt-in-Negativtest | PASS |
| HOTL Dashboard Session-Abgrenzung | PASS |
| Kubernetes v1.37.0 | Ready |
| nginx Recovery | 2/2 Ready |
| Basisservices | 4/4 HTTP OK |
| TypeScript / Vite Build | PASS |
| ADR-021 Diagnostics | PASS |
| Git Working Tree | Clean |

**Demo-Freeze:** Lokaler Branch `demo/ai-thinkers-live`, Commit `01285df`.

## 10. Abschluss / Demo-Freeze

- Vor dem Auftritt keine weiteren Codeänderungen, Merges, Cluster-Resets oder Credential-Ausgaben auf dem Beamer.
- Keine Kubeconfig-Inhalte, Tokens oder vertraulichen Daten zeigen.
- `--once` beendet den HOTL-Supervisor nach erfolgreicher Recovery; für einen weiteren Lauf ist erneute explizite Aktivierung erforderlich.
- Die lokale JSONL-Evidence ist nicht signiert oder manipulationssicher.
- Der kombinierte Demo-Branch ist zunächst nur lokal; PRs #178 (HOTL), #179 (HITL-Branding), #180 (Console) bleiben separat.

### Kernbotschaft

> **HITL:** AI thinks. Human approves. OpenKubes executes.
> **HOTL:** AI thinks. Policy governs. OpenKubes executes. Human oversees. Evidence proves.

**OpenKubes AI Thinkerers – from Human-approved Automation to Human-supervised Autonomy.**
