import { createElement, memo } from "react";
import type { ComponentType } from "react";
import type { MessageKey } from "../i18n/messages";
import { FlowListeningSpace } from "../features/player/FlowListeningSpace";
import { MusicListeningSpace } from "../features/player/MusicListeningSpace";
import type { AtmosphereSpace } from "../features/player/motionTokens";
import { ScrollLyricsSpace } from "../features/player/ScrollLyricsSpace";
import { ImprintListeningSpace } from "./imprint";
import type {
  ListeningSpaceComponentProps,
  ListeningSpaceId,
} from "./types";

export interface ListeningSpaceDefinition {
  id: ListeningSpaceId;
  name: string;
  number: string;
  title: string;
  description: string;
  descriptionKey: MessageKey;
  atmosphereSpace: AtmosphereSpace | null;
  metadata: ListeningSpaceMetadata;
  component: ComponentType<ListeningSpaceComponentProps>;
}

export type ListeningSpaceCoverTransition = "passage" | "intact";

export interface ListeningSpaceMetadata {
  number: string;
  title: string;
  description: string;
  descriptionKey: MessageKey;
  atmosphereSpace: AtmosphereSpace | null;
  coverTransition: ListeningSpaceCoverTransition;
}

type ListeningSpaceRegistration = Omit<
  ListeningSpaceDefinition,
  "name" | "number" | "metadata"
> & {
  coverTransition: ListeningSpaceCoverTransition;
};

function defineListeningSpace({
  coverTransition,
  ...definition
}: ListeningSpaceRegistration, number: string): ListeningSpaceDefinition {
  const metadata: ListeningSpaceMetadata = {
    number,
    title: definition.title,
    description: definition.description,
    descriptionKey: definition.descriptionKey,
    atmosphereSpace: definition.atmosphereSpace,
    coverTransition,
  };

  return {
    ...definition,
    number,
    name: `${number} ${definition.title}`,
    metadata,
  };
}

const listeningSpaceRegistrations = [
  {
    id: "music",
    title: "MUSIC SPACE",
    description: "当前歌词与空间氛围",
    descriptionKey: "space.music.description",
    atmosphereSpace: "music",
    coverTransition: "passage",
    component: MusicListeningSpace,
  },
  {
    id: "lyrics-flow",
    title: "LYRICS FLOW",
    description: "多句歌词的三维焦点",
    descriptionKey: "space.lyricsFlow.description",
    atmosphereSpace: "flow",
    coverTransition: "passage",
    component: FlowListeningSpace,
  },
  {
    id: "typography",
    title: "TYPOGRAPHY",
    description: "随演唱重新构图的动态歌词海报",
    descriptionKey: "space.typography.description",
    atmosphereSpace: "typography",
    coverTransition: "passage",
    component: ScrollLyricsSpace,
  },
  {
    id: "imprint",
    title: "IMPRINT SPACE",
    description: "逐字压进音乐空间的印迹校样",
    descriptionKey: "space.imprint.description",
    atmosphereSpace: null,
    coverTransition: "passage",
    component: ImprintListeningSpace,
  },
] satisfies readonly ListeningSpaceRegistration[];

export const ListeningSpaceRegistry = listeningSpaceRegistrations.map(
  (definition, index) => defineListeningSpace(
    definition,
    String(index + 1).padStart(2, "0"),
  ),
);

const registryById = new Map<ListeningSpaceId, ListeningSpaceDefinition>(
  ListeningSpaceRegistry.map((definition) => [definition.id, definition]),
);

export function getListeningSpaceDefinition(id: ListeningSpaceId) {
  return registryById.get(id) ?? ListeningSpaceRegistry[0];
}

export const ListeningSpaceRenderer = memo(
  function ListeningSpaceRenderer({
    mode,
    ...props
  }: ListeningSpaceComponentProps & { mode: ListeningSpaceId }) {
    const definition = getListeningSpaceDefinition(mode);
    return createElement(definition.component, props);
  },
);
