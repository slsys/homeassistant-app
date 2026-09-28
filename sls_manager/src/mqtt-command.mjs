import { GatewayError } from './gateway.mjs';

// Commands are never retained or queued for a later reconnect.
export function publishReboot(client, prefix) {
  if (!client?.connected) throw new GatewayError('Нет подключения к MQTT-брокеру', 'validation');
  if (typeof prefix !== 'string' || !prefix || prefix.length > 200 || /[+#\x00-\x1f\x7f]/.test(prefix))
    throw new GatewayError('Некорректный префикс MQTT', 'validation');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new GatewayError(
          'Отправка MQTT не подтверждена. Ожидаем данные о перезагрузке; команда не повторяется.',
          'mqtt_uncertain',
        )),
      client.viaHomeAssistant ? 10000 : 5000,
    );
    timer.unref?.();
    const done = (error) => {
      clearTimeout(timer);
      if (error?.code === 'delivery_unknown')
        reject(new GatewayError(
          'HA не подтвердил отправку. Ожидаем данные о перезагрузке; команда не повторяется.',
          'mqtt_uncertain',
        ));
      else if (error) reject(new GatewayError('Не удалось отправить команду MQTT', 'mqtt'));
      else resolve();
    };
    try {
      client.publish(prefix + '/reboot/set', '1', { qos: 0, retain: false }, done);
    } catch (error) {
      done(error);
    }
  });
}
