import { JsonPatchFactory, WorkflowEvent, WorkflowStepJobEvent, applyPatch } from '@civitai/client';
import { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { cloneDeep } from 'lodash-es';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useUpdateWorkflowSteps } from '~/components/Orchestrator/hooks/workflowStepHooks';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { updateQueries } from '~/hooks/trpcHelpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import {
  GeneratedImageStepMetadata,
  TextToImageStepImageMetadata,
} from '~/server/schema/orchestrator/textToImage.schema';
import {
  PatchWorkflowParams,
  PatchWorkflowStepParams,
  TagsPatchSchema,
  workflowQuerySchema,
} from '~/server/schema/orchestrator/workflows.schema';
import {
  WorkflowStepFormatted,
  queryGeneratedImageWorkflows,
} from '~/server/services/orchestrator/common';
import {
  IWorkflow,
  IWorkflowsInfinite,
  UpdateWorkflowStepParams,
} from '~/server/services/orchestrator/orchestrator.schema';
import {
  WORKFLOW_TAGS,
  orchestratorCompletedStatuses,
} from '~/shared/constants/generation.constants';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { queryClient, trpc } from '~/utils/trpc';

type InfiniteTextToImageRequests = InfiniteData<
  AsyncReturnType<typeof queryGeneratedImageWorkflows>
>;

export function useGetTextToImageRequests(
  input?: z.input<typeof workflowQuerySchema>,
  options?: { enabled?: boolean }
) {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.orchestrator.queryGeneratedImages.useInfiniteQuery(input ?? {}, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    enabled: !!currentUser,
    ...options,
  });

  const flatData = useMemo(
    () =>
      data?.pages.flatMap((x) =>
        (x.items ?? []).filter((workflow) => {
          if (!!input?.tags?.length && workflow.tags.every(tag => !input?.tags?.includes(tag))) return false
          return true;
        }).map((response) => {
          const steps = response.steps.map((step) => {
            const images = step.images
              .filter(({ id }) => {
                const imageMeta = step.metadata?.images?.[id]
                if (imageMeta?.hidden) return false
                if (input?.tags?.includes(WORKFLOW_TAGS.FAVORITE) && !imageMeta?.favorite) return false;
                if (input?.tags?.includes(WORKFLOW_TAGS.FEEDBACK.LIKED) && imageMeta?.feedback !== 'liked') return false;
                if (input?.tags?.includes(WORKFLOW_TAGS.FEEDBACK.DISLIKED) && imageMeta?.feedback !== 'disliked') return false;
                return true;
              })
              .sort((a, b) => {
                if (!b.completed) return 1;
                if (!a.completed) return -1;
                return b.completed.getTime() - a.completed.getTime();
                // if (a.completed !== b.completed) {
                //   if (!b.completed) return 1;
                //   if (!a.completed) return -1;
                //   return b.completed.getTime() - a.completed.getTime();
                // } else {
                //   if (a.id < b.id) return -1;
                //   if (a.id > b.id) return 1;
                //   return 0;
                // }
              });
            return { ...step, images };
          });
          return { ...response, steps };
        })
      ) ?? [],
    [data]
  );

  // useEffect(() => console.log({ flatData }), [flatData]);
  const steps = useMemo(() => flatData.flatMap((x) => x.steps), [flatData]);
  const images = useMemo(() => steps.flatMap((x) => x.images), [steps]);

  return { data: flatData, steps, images, ...rest };
}

export function useGetTextToImageRequestsImages(input?: z.input<typeof workflowQuerySchema>) {
  const { data, steps, ...rest } = useGetTextToImageRequests(input);

  return { requests: data, steps, ...rest };
}

function updateTextToImageRequests(cb: (data: InfiniteTextToImageRequests) => void) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  // const test = queryClient.getQueriesData({ queryKey, exact: false })
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: InfiniteTextToImageRequests) => {
      if (!old) return;
      cb(old);
    })
  );
}

export function useSubmitCreateImage() {
  return trpc.orchestrator.generateImage.useMutation({
    onSuccess: (data) => {
      updateTextToImageRequests((old) => {
        old.pages[0].items.unshift(data);
      });
      updateFromEvents();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
    },
  });
}

export function useDeleteTextToImageRequest() {
  return trpc.orchestrator.deleteWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((data) => {
        for (const page of data.pages) {
          const index = page.items.findIndex((x) => x.id === workflowId);
          if (index > -1) page.items.splice(index, 1);
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error deleting request',
        error: new Error(error.message),
      });
    },
  });
}

export function useCancelTextToImageRequest() {
  return trpc.orchestrator.cancelWorkflow.useMutation({
    onSuccess: (_, { workflowId }) => {
      updateTextToImageRequests((old) => {
        for (const page of old.pages) {
          for (const item of page.items.filter((x) => x.id === workflowId)) {
            for (const step of item.steps) {
              for (const image of step.images.filter(
                (x) => !orchestratorCompletedStatuses.includes(x.status)
              )) {
                image.status = 'canceled';
              }
              if (step.images.some((x) => x.status === 'canceled')) {
                item.status = 'canceled';
              }
            }
          }
        }
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error cancelling request',
        error: new Error(error.message),
      });
    },
  });
}

export type UpdateImageStepMetadataArgs = {
  workflowId: string;
  stepName: string;
  images: Record<string, TextToImageStepImageMetadata>;
};

export function useUpdateImageStepMetadata(options?: { onSuccess?: () => void }) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const { mutate, isLoading } = trpc.orchestrator.patch.useMutation();

  function updateImages(args: Array<UpdateImageStepMetadataArgs>) {
    const allQueriesData = queryClient.getQueriesData<IWorkflowsInfinite>({
      queryKey,
      exact: false,
    });

    // add workflows from query cache to an array for quick reference
    const workflows: IWorkflow[] = [];
    loop: for (const [, queryData] of allQueriesData) {
      for (const page of queryData?.pages ?? []) {
        for (const workflow of page.items) {
          const match = args.find((x) => x.workflowId === workflow.id);
          if (match) workflows.push(workflow);
          if (workflows.length === args.length) break loop;
        }
      }
    }

    const workflowPatches: PatchWorkflowParams[] = [];
    const stepPatches: PatchWorkflowStepParams[] = [];
    const updated: UpdateImageStepMetadataArgs[] = [];
    const tags: { workflowId: string; tag: string; op: 'add' | 'remove' }[] = [];
    const toDelete: string[] = [];

    // function addWorkflowPatches({ workflowId, patches }: PatchWorkflowParams) {
    //   const index = workflowPatches.findIndex((x) => x.workflowId === workflowId);
    //   if (index === -1) workflowPatches.push({ workflowId, patches });
    //   else workflowPatches[index].patches = workflowPatches[index].patches.concat(patches);
    // }

    for (const workflow of workflows) {
      const match = args.find((x) => x.workflowId === workflow.id);
      if (!match) continue;
      const { workflowId, stepName, images } = match;
      // let favorites: boolean | undefined;
      for (const step of workflow.steps as WorkflowStepFormatted[]) {
        if (step.name !== stepName) continue;
        const metadata = step.metadata ?? {};
        const jsonPatch = new JsonPatchFactory<GeneratedImageStepMetadata>();
        // const images = metadata.images ?? {}
        if (!metadata.images) jsonPatch.addOperation({ op: 'add', path: 'images', value: {} });
        for (const imageId in images) {
          if (!metadata.images?.[imageId])
            jsonPatch.addOperation({ op: 'add', path: `images/${imageId}`, value: {} });

          const current = metadata.images?.[imageId] ?? {};
          const { hidden, feedback, comments, postId, favorite } = match.images[imageId];
          if (hidden)
            jsonPatch.addOperation({ op: 'add', path: `images/${imageId}/hidden`, value: true });
          if (feedback) {
            jsonPatch.addOperation({
              op: feedback !== current.feedback ? 'add' : 'remove',
              path: `images/${imageId}/feedback`,
              value: feedback,
            });
          }
          if (comments)
            jsonPatch.addOperation({
              op: 'add',
              path: `images/${imageId}/comments`,
              value: comments,
            });
          if (postId)
            jsonPatch.addOperation({
              op: 'add',
              path: `images/${imageId}/postId`,
              value: postId,
            });
          if (favorite !== undefined) {
            jsonPatch.addOperation({
              op: favorite ? 'add' : 'remove',
              path: `images/${imageId}/favorite`,
              value: true,
            });
          }
        }

        const clone = cloneDeep(metadata);
        applyPatch(clone, jsonPatch.operations);
        const patchedImages = clone.images ?? {};

        // first check if the workflow should be deleted
        const hiddenCount = Object.values(patchedImages).filter((x) => x.hidden).length;
        if (step.images.length === hiddenCount) {
          toDelete.push(workflow.id);
        } else {
          const images = removeEmpty(patchedImages);
          // return transformed data
          updated.push({ workflowId, stepName, images });

          const hasTagFavorite = workflow.tags.includes(WORKFLOW_TAGS.FAVORITE);
          const hasTagLike = workflow.tags.includes(WORKFLOW_TAGS.FEEDBACK.LIKED);
          const hasTagDislike = workflow.tags.includes(WORKFLOW_TAGS.FEEDBACK.DISLIKED);

          const hasFavoriteImages = Object.values(images).some((x) => x.favorite);
          const hasLikedImages = Object.values(images).some((x) => x.feedback === 'liked');
          const hasDislikedImages = Object.values(images).some((x) => x.feedback === 'disliked');

          if (hasTagFavorite && !hasFavoriteImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FAVORITE, op: 'remove' });
          }

          else if (!hasTagFavorite && hasFavoriteImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FAVORITE, op: 'add' });
          }

          if (hasTagLike && !hasLikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.LIKED, op: 'remove' });
          }

          else if (!hasTagLike && hasLikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.LIKED, op: 'add' });
          }

          if (hasTagLike && !hasLikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.DISLIKED, op: 'remove' });
          }

          else if (!hasTagDislike && hasDislikedImages) {
            tags.push({ workflowId, tag: WORKFLOW_TAGS.FEEDBACK.DISLIKED, op: 'add' });
          }

          // if (Object.values(images).every((x) => !x.favorite)) favorites = false;
          // else if (Object.values(images).some((x) => x.favorite)) favorites = true;

          // addWorkflowPatches({
          //   workflowId,
          //   patches: jsonPatch.operations.map((operation) => ({
          //     ...operation,
          //     path: `/steps/${stepName}/metadata${operation.path}`,
          //   })),
          // });

          stepPatches.push({ workflowId, stepName, patches: jsonPatch.operations });
        }

        // const tagPatches = new JsonPatchFactory<{ tags: string[] }>();
        // if (favorites === true) {
        //   tagPatches.addOperation({
        //     op: 'add',
        //     path: 'tags/-',
        //     value: WORKFLOW_TAGS.FAVORITE,
        //   });
        // } else if (favorites === false) {
        //   const favoritesIndex = workflow.tags.indexOf(WORKFLOW_TAGS.FAVORITE);
        //   if (favoritesIndex > -1)
        //     tagPatches.addOperation({ op: 'remove', path: `tags/${favoritesIndex}` });
        // }
        // if (tagPatches.operations.length > 0) {
        //   addWorkflowPatches({ workflowId, patches: tagPatches.operations });
        // }
      }
    }

    mutate(
      {
        workflows: workflowPatches.length ? workflowPatches : undefined,
        steps: stepPatches.length ? stepPatches : undefined,
        remove: toDelete.length ? toDelete : undefined,
        tags: tags.length ? tags : undefined,
      },
      {
        onSuccess: () => {
          updateQueries<IWorkflowsInfinite>(queryKey, (old) => {
            for (const page of old.pages) {
              // remove deleted items
              page.items = page.items.filter((x) => !toDelete.includes(x.id));
              for (const workflow of page.items) {
                // add/remove workflow tags
                const addTagsMatch = tags.find(
                  (x) => x.workflowId === workflow.id && x.op === 'add'
                );
                const removeTagsMatch = tags.find(
                  (x) => x.workflowId === workflow.id && x.op === 'remove'
                );
                if (addTagsMatch) workflow.tags.push(addTagsMatch.tag);
                if (removeTagsMatch)
                  workflow.tags = workflow.tags.filter((tag) => tag !== removeTagsMatch.tag);

                const toUpdate = updated.filter((x) => x.workflowId === workflow.id);
                if (!toUpdate.length) continue;
                for (const step of workflow.steps) {
                  const images = toUpdate.find((x) => x.stepName === step.name)?.images;
                  if (images) step.metadata = { ...step.metadata, images };
                }
              }
            }
          });

          const tagNames = [...new Set(tags.filter(x => x.op === 'add').map(x => x.tag))]
          // ['favorite' 'feedback:liked', 'feedback:'disliked']
          for (const tag of tagNames) {
            const key = getQueryKey(trpc.orchestrator.queryGeneratedImages, { tags: [tag] })
            queryClient.invalidateQueries(key, { exact: false })
          }

          options?.onSuccess?.();
        }
      }
    );
  }

  return { updateImages, isLoading };
}

export function usePatchTags() {
  const { mutate, isLoading } = trpc.orchestrator.patch.useMutation();
  function patchTags(tags: TagsPatchSchema[]) {
    mutate({ tags });
  }

  return { patchTags, isLoading };
}

export function useUpdateTextToImageStepMetadata(options?: { onSuccess?: () => void }) {
  const queryKey = getQueryKey(trpc.orchestrator.queryGeneratedImages);
  const { updateSteps, isLoading } = useUpdateWorkflowSteps({
    queryKey,
    onSuccess: options?.onSuccess,
  });

  function updateImages(
    args: Array<{
      workflowId: string;
      stepName: string;
      imageId: string;
      hidden?: boolean;
      feedback?: 'liked' | 'disliked';
      comments?: string;
      postId?: number;
    }>
  ) {
    const data = args.reduce<Extract<UpdateWorkflowStepParams, { $type: 'textToImage' }>[]>(
      (acc, { workflowId, stepName, imageId, ...metadata }) => {
        const index = acc.findIndex((x) => x.workflowId === workflowId && x.stepName === stepName);
        const toUpdate: Extract<UpdateWorkflowStepParams, { $type: 'textToImage' }> =
          index > -1
            ? acc[index]
            : {
              $type: 'textToImage',
              workflowId,
              stepName,
              metadata: {},
            };
        const images = toUpdate.metadata.images ?? {};
        images[imageId] = { ...images[imageId], ...removeEmpty(metadata) };
        toUpdate.metadata.images = images;
        if (index > -1) acc[index] = toUpdate;
        else acc.push(toUpdate);
        return acc;
      },
      []
    );

    updateSteps<GeneratedImageStepMetadata>(
      data,
      (draft, metadata) => {
        Object.keys(metadata.images ?? {}).map((imageId) => {
          const { feedback, ...rest } = metadata.images?.[imageId] ?? {};
          const images = draft.images ?? {};
          images[imageId] = { ...images[imageId], ...removeEmpty(rest) };
          if (feedback)
            images[imageId].feedback = images[imageId].feedback !== feedback ? feedback : undefined;
          draft.images = images;
        });
      },
      !!args.find((x) => x.feedback !== undefined) ? 'feedback' : undefined // TODO - temp for giving buzz for feedback
    );
  }

  return { updateImages, isLoading };
}

type CustomJobEvent = Omit<WorkflowStepJobEvent, '$type'> & { $type: 'job'; completed?: Date };
type CustomWorkflowEvent = Omit<WorkflowEvent, '$type'> & { $type: 'workflow' };
const debouncer = createDebouncer(100);
const signalJobEventsDictionary: Record<string, CustomJobEvent> = {};
const signalWorkflowEventsDictionary: Record<string, CustomWorkflowEvent> = {};
export function useTextToImageSignalUpdate() {
  return useSignalConnection(
    SignalMessages.TextToImageUpdate,
    (data: CustomJobEvent | CustomWorkflowEvent) => {
      if (data.$type === 'job' && data.jobId) {
        signalJobEventsDictionary[data.jobId] = { ...data, completed: new Date() };
      } else if (data.$type === 'workflow' && data.workflowId) {
        signalWorkflowEventsDictionary[data.workflowId] = data;
      }

      debouncer(() => updateFromEvents());
    }
  );
}

function updateFromEvents() {
  if (!Object.keys(signalJobEventsDictionary).length) return;

  updateTextToImageRequests((old) => {
    for (const page of old.pages) {
      for (const item of page.items) {
        if (
          !Object.keys(signalJobEventsDictionary).length &&
          !Object.keys(signalWorkflowEventsDictionary).length
        )
          return;

        const workflowEvent = signalWorkflowEventsDictionary[item.id];
        if (workflowEvent) {
          item.status = workflowEvent.status!;
          if (item.status === signalWorkflowEventsDictionary[item.id].status)
            delete signalWorkflowEventsDictionary[item.id];
        }

        for (const step of item.steps) {
          // get all jobIds associated with images
          const imageJobIds = [...new Set(step.images.map((x) => x.jobId))];
          // get any pending events associated with imageJobIds
          const jobEventIds = Object.keys(signalJobEventsDictionary).filter((jobId) =>
            imageJobIds.includes(jobId)
          );

          for (const jobId of jobEventIds) {
            const signalEvent = signalJobEventsDictionary[jobId];
            if (!signalEvent) continue;
            const { status } = signalEvent;
            const images = step.images.filter((x) => x.jobId === jobId);
            for (const image of images) {
              image.status = signalEvent.status!;
              image.completed = signalEvent.completed;
            }

            if (status === signalJobEventsDictionary[jobId].status) {
              delete signalJobEventsDictionary[jobId];
              if (!Object.keys(signalJobEventsDictionary).length) break;
            }
          }
        }
      }
    }
  });
}   
