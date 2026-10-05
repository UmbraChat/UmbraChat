import { PROTOCOL_VERSION, describeMismatch, type ProtocolMismatch } from "../api/protocol";
import { getServerUrl } from "../api/server";

export function VersionMismatch({ mismatch }: { mismatch: ProtocolMismatch }) {
  return (
    <main className="screen">
      <div className="panel stack" data-testid="version-mismatch">
        <h1>Update needed</h1>
        <p role="alert">{describeMismatch(mismatch)}</p>
        <p className="hint">
          Server: {getServerUrl() || window.location.origin}. Protocol of this app: {PROTOCOL_VERSION}, of the server: {mismatch.server ?? "none"}. Nothing is sent or received until both sides run the same build.
        </p>
        <button onClick={() => window.location.reload()}>Check again</button>
      </div>
    </main>
  );
}
