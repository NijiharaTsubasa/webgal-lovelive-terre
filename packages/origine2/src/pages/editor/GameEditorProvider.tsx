import { goTo } from "@/router";
import { gameListFetcher } from "@/pages/dashboard/DashBoard";
import useEditorStore from "@/store/useEditorStore";
import { GameEditorContext, createGameEditorStore } from "@/store/useGameEditorStore";
import { Spinner } from "@fluentui/react-components";
import { ReactNode, useRef } from "react";
import useSWR from "swr";
import { GltfCatalogEnabledContext, useGltfCatalogSession } from '@/hooks/gltf/useGltfCatalog';

const GameEditorProvider = ({ children }: { children: ReactNode }) => {
  const page = useEditorStore.use.page();
  const gameDir = useEditorStore.use.subPage();

  if (page !== 'game' || !gameDir) {
    goTo('dashboard', 'game');
  };

  const { data: gameList, isLoading: gameListLoading } = useSWR("game-list", gameListFetcher);
  const fristLoading = gameListLoading && !gameList;
  const game = gameList?.find((game) => game.dir === gameDir);

  if (!fristLoading && !game) {
    goTo('dashboard', 'game');
  }

  return (
    <>
      {
        fristLoading &&
        <div style={{ height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Spinner labelPosition="below" label={gameDir} />
        </div>
      }
      {game && !fristLoading && <GameEditorContextProvider key={gameDir} gltfEnabled={game.gltfEnabled}>{children}</GameEditorContextProvider>}
    </>
  );
};

const GameEditorContextProvider = ({ children, gltfEnabled }: { children: ReactNode; gltfEnabled: boolean }) => {
  const gameDir = useEditorStore.use.subPage();
  useGltfCatalogSession(gltfEnabled ? gameDir : undefined);
  const gameEditorStore = useRef(createGameEditorStore(gameDir)).current;
  return (
    <GameEditorContext.Provider value={gameEditorStore}>
      <GltfCatalogEnabledContext.Provider value={gltfEnabled}>{children}</GltfCatalogEnabledContext.Provider>
    </GameEditorContext.Provider>
  );
};

export default GameEditorProvider;
