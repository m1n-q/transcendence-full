import { UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConsumeMessage } from 'amqplib';
import { RmqEvent } from '../common/rmq/types/rmq-event';
import { AuthService } from '../auth/auth.service';
import { WsExceptionsFilter } from '../common/ws/ws-exceptions.filter';
import { UserProfile } from '../user/types/user-profile';
import { toUserProfile } from '../common/utils/utils';
import { UserService } from '../user/services/user.service';
import { v4 } from 'uuid';

@UseFilters(new WsExceptionsFilter())
@WebSocketGateway(9994, { cors: true })
export class StateGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Server;
  private serverId: string;

  constructor(
    private readonly authService: AuthService,
    private readonly amqpConnection: AmqpConnection,
    private readonly userService: UserService,
  ) {
    this.serverId = v4();
  }

  //@======================================================================@//
  //@                             Connection                               @//
  //@======================================================================@//

  @UseFilters(new WsExceptionsFilter())
  async handleConnection(
    @ConnectedSocket() clientSocket: Socket,
    ...args: any[]
  ) {
    let user: UserProfile;

    try {
      user = await this.bindUser(clientSocket);
    } catch (e) {
      clientSocket.disconnect(true);
      return;
    }

    const observerSocket = clientSocket;
    const subject = clientSocket;

    observerSocket.emit('update', {
      user: subject,
      status: 'ONLINE',
    });

    //BUG: unhandled rejection - Exception filter does not catch?!
    const friends = await this.userService
      .getFriends(user.user_id)
      .catch((e) => console.log(e));
    if (!friends) return;

    const subjects = friends.map((friend) => friend.user_id);

    const result = await this.amqpConnection
      .createSubscriber(
        (ev: RmqEvent, rawMsg) => this.stateEventHandler(ev, rawMsg),
        {
          exchange: process.env.RMQ_STATE_TOPIC,
          queue: this.observerQ((await this.getUser(clientSocket)).user_id),
          routingKey: subjects.map((subject) =>
            this.subjectRK('update', subject),
          ),
          errorHandler: (c, m, e) => console.error(e),
          queueOptions: { autoDelete: true },
        },
        'stateEventHandler',
        {
          consumerTag: clientSocket.id,
        },
      )
      .catch((e) => console.log(e));
  }

  async handleDisconnect(@ConnectedSocket() clientSocket: Socket) {
    await this.amqpConnection.channel
      .deleteQueue(this.observerQ((await this.getUser(clientSocket)).user_id))
      .catch((e) => console.log(e));
  }

  //.======================================================================.//
  //.                          Socket.io handler                           .//
  //.======================================================================.//
  @SubscribeMessage('subscribe')
  async subscribeUsers(
    @MessageBody() message,
    @ConnectedSocket() clientSocket: Socket,
  ) {
    await this.amqpConnection
      .createSubscriber(
        (ev: RmqEvent, rawMsg) => this.stateEventHandler(ev, rawMsg),
        {
          exchange: process.env.RMQ_STATE_TOPIC,
          queue: this.observerQ((await this.getUser(clientSocket)).user_id),
          routingKey: message.subjects.map((subject) =>
            this.subjectRK('update', subject),
          ),
          errorHandler: (c, m, e) => console.error(e),
          queueOptions: { autoDelete: true },
        },
        'stateEventHandler',
      )
      .catch((e) => console.log(e));
  }

  //'======================================================================'//
  //'                           RabbitMQ handler                           '//
  //'======================================================================'//

  async stateEventHandler(ev: RmqEvent, rawMsg: ConsumeMessage) {
    const re = /(?<=event.on.state.)(.*)(?=.rk)/;
    const params = re.exec(rawMsg.fields.routingKey)[0].split('.');

    const { 0: evType, 1: subject } = params;

    switch (evType) {
      case 'update':
        this.getClientSocket(rawMsg.fields.consumerTag)
?.emit('update', {
          user: subject,
          state: ev.data,
        });
        break;
      default:
        console.log('unknown event');
    }
  }

  //#======================================================================#//
  //#                                ETC                                   #//
  //#======================================================================#//

  stateTX() {
    return process.env.RMQ_STATE_TOPIC;
  }

  subjectRK(evType: string, subUserId: string) {
    return `event.on.state.${evType}.${subUserId}.rk`;
  }

  observerQ(userId: string) {
    return `state.observer.${userId}.q`;
  }

  async bindUser(clientSocket: Socket) {
    /* get user info */
    const access_token = clientSocket.handshake.auth['access_token'];
    let payload;
    let user;
    try {
      payload = await this.authService.verifyJwt(access_token);
      user = await this.userService.getUserProfileById(payload.user_id);
    } catch (e) {
      throw new WsException(e);
    }

    /* bind user info to socket */
    clientSocket['user_profile'] = toUserProfile(user);
    return user;
  }

  async getUser(clientSocket: Socket): Promise<UserProfile> {
    return clientSocket['user_profile'];
  }

  getClientSocket(sockId: string): Socket {
    return this.server.sockets.sockets.get(sockId);
  }
}
