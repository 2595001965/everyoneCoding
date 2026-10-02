import { z } from 'zod';
import type { ElementAnchor } from '@ec/core';

const identity = z.string().min(1).max(128);
const shortText = z.string().max(200);
export const domSessionSchema = z
  .object({
    projectId: identity,
    runtimeId: identity,
    nonce: identity,
    parentOrigin: z.string().min(1).max(256),
  })
  .strict();
export type DomSession = z.infer<typeof domSessionSchema>;
export const domNodeSchema = z
  .object({
    nodeId: identity,
    tag: z
      .string()
      .regex(/^[a-z][a-z0-9:-]*$/)
      .max(64),
    name: shortText,
    id: shortText.nullable(),
    classes: z.array(z.string().max(80)).max(12),
    sourceToken: identity.nullable(),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const domSelectionSchema = z
  .object({
    node: domNodeSchema,
    ancestors: z.array(domNodeSchema).max(24),
    route: z.string().min(1).max(512),
    documentId: identity,
    instanceIndex: z.number().int().nonnegative(),
    instanceCount: z.number().int().min(1).max(100000),
    boundary: z.enum(['dom', 'iframe', 'shadow-host', 'canvas']),
  })
  .strict()
  .refine((selection) => selection.instanceIndex < selection.instanceCount, '实例序号越界');
export type DomNode = z.infer<typeof domNodeSchema>;
export type DomSelection = z.infer<typeof domSelectionSchema>;
const envelope = domSessionSchema.omit({ parentOrigin: true }).extend({
  channel: z.literal('ec-dom-v1'),
  documentId: identity,
  seq: z.number().int().positive(),
});
export const domEventSchema = z.discriminatedUnion('type', [
  envelope.extend({ type: z.literal('ready'), payload: z.null() }).strict(),
  envelope.extend({ type: z.literal('selection'), payload: domSelectionSchema }).strict(),
  envelope.extend({ type: z.literal('hover'), payload: domNodeSchema }).strict(),
  envelope.extend({ type: z.literal('invalidated'), payload: shortText }).strict(),
  envelope.extend({ type: z.literal('mode'), payload: z.boolean() }).strict(),
]);
export type DomEvent = z.infer<typeof domEventSchema>;
export type DomCommand = DomSession & {
  channel: 'ec-dom-v1';
  documentId: string;
  type: 'mode' | 'pick';
  payload: boolean | string;
};

export interface DomMapping {
  anchor: ElementAnchor;
  startColumn: number | null;
  endColumn: number | null;
  shared: { renderedInstances: number; scope: string; requiresConfirmation: boolean };
  relatedApis: readonly string[];
}
export interface DomAttachment {
  selection: DomSelection;
  mapping: DomMapping;
  note: string;
  placement: 'before' | 'after' | 'inside';
  targetPage: string;
  attached: boolean;
}

/** Opaque sandbox origins are accepted only together with the exact WindowProxy and session. */
export function readDomEvent(
  event: MessageEvent,
  source: Window | null,
  session: DomSession,
): DomEvent | null {
  if (source === null || event.source !== source || event.origin !== 'null') return null;
  const parsed = domEventSchema.safeParse(event.data);
  if (!parsed.success) return null;
  const message = parsed.data;
  if (
    message.projectId !== session.projectId ||
    message.runtimeId !== session.runtimeId ||
    message.nonce !== session.nonce
  )
    return null;
  if (message.type === 'selection' && message.payload.documentId !== message.documentId)
    return null;
  return message;
}
