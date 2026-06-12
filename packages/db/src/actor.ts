import { Schema } from "effect";

export const ActorType = Schema.Literal("human", "worker", "system");
export type ActorType = Schema.Schema.Type<typeof ActorType>;
