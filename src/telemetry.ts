import { trace, type Tracer } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMicroseconds, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";

const SERVICE = "gated-github-mcp";

/**
 * Console exporter that writes one JSON line per span to STDERR.
 *
 * The SDK's own ConsoleSpanExporter uses console.dir, i.e. stdout, which is the
 * MCP protocol channel for a stdio server: a single span would corrupt it.
 */
export class StderrSpanExporter implements SpanExporter {
  constructor(private readonly write: (line: string) => void = (l) => process.stderr.write(l)) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      for (const s of spans) {
        const ctx = s.spanContext();
        this.write(
          `${JSON.stringify({
            otel: "span",
            name: s.name,
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            kind: s.kind,
            timestamp: hrTimeToMicroseconds(s.startTime),
            duration_us: hrTimeToMicroseconds(s.duration),
            status: s.status,
            attributes: s.attributes,
            resource: s.resource.attributes,
          })}\n`,
        );
      }
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Returns the tracer for tool-call spans. Tracing is opt-in via the standard
 * OTEL_TRACES_EXPORTER variable; only "console" is supported. Anything else
 * (including unset) yields the API's no-op tracer.
 */
export function initTelemetry(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): Tracer {
  const exporter = env.OTEL_TRACES_EXPORTER?.trim();
  if (exporter && exporter !== "console" && exporter !== "none") {
    warn(`OTEL_TRACES_EXPORTER=${exporter} is not supported (only "console"); tracing disabled`);
  }
  if (exporter !== "console") return trace.getTracer(SERVICE);

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE, "service.version": "0.1.0" }),
    spanProcessors: [new SimpleSpanProcessor(new StderrSpanExporter())],
  });
  return provider.getTracer(SERVICE);
}
