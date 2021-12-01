import {
  /* inject, */
  injectable,
  Interceptor,
  InvocationContext,
  InvocationResult,
  Provider,
  service,
  ValueOrPromise,
} from '@loopback/core';
import {RestBindings} from '@loopback/rest';
import {ControllerType, FriendStatusType, PlatformType} from '../enums';
import {FriendService, PostService} from '../services';

/**
 * This class will be bound to the application as an `Interceptor` during
 * `boot`
 */
@injectable({tags: {key: DeletedDocument.BINDING_KEY}})
export class DeletedDocument implements Provider<Interceptor> {
  static readonly BINDING_KEY = `interceptors.${DeletedDocument.name}`;

  constructor(
    @service(FriendService)
    protected friendService: FriendService,
    @service(PostService)
    protected postService: PostService,
  ) {}

  /**
   * This method is used by LoopBack context to produce an interceptor function
   * for the binding.
   *
   * @returns An interceptor function
   */
  value() {
    return this.intercept.bind(this);
  }

  /**
   * The logic to intercept an invocation
   * @param invocationCtx - Invocation context
   * @param next - A function to invoke next interceptor or the target method
   */
  async intercept(
    invocationCtx: InvocationContext,
    next: () => ValueOrPromise<InvocationResult>,
  ) {
    const {query} = await invocationCtx.get(RestBindings.Http.REQUEST);
    const {userId} = query;
    const id = invocationCtx.args[0];
    const className = invocationCtx.targetClass.name as ControllerType;

    if (className === ControllerType.USER) {
      if (userId) {
        const friend = await this.friendService.friendRepository.findOne({
          where: {
            or: [
              {
                requesteeId: userId.toString(),
                requestorId: id,
              },
              {
                requesteeId: id,
                requestorId: userId.toString(),
              },
            ],
          },
        });

        if (friend && friend.status === FriendStatusType.BLOCKED) return null;
      }
    }
    // Add pre-invocation logic here
    let result = await next();
    // Add post-invocation logic here
    if (className === ControllerType.POST && result.message) return result;
    if (
      className === ControllerType.POST &&
      result.platform !== PlatformType.MYRIAD
    ) {
      const postUserId = result.createdBy;
      const friendIds = await this.friendService.getImporterIds(postUserId);
      const detailImporters = await this.postService.getDetailImporters(
        result,
        friendIds,
      );

      result = Object.assign(result, detailImporters);
    }

    if (result.deletedAt) {
      switch (className) {
        case ControllerType.USER:
          return Object.assign(result, {
            name: '[user banned]',
          });

        case ControllerType.POST:
          return Object.assign(result, {
            text: '[post removed]',
          });

        case ControllerType.COMMENT:
          return Object.assign(result, {
            text: '[comment removed]',
          });

        default:
          return null;
      }
    }

    return result;
  }
}
