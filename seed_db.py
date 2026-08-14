from db_api import create_device, list_devices

create_device('device1', ip='153.80.251.46', port=4567, password=None, name='device1')
print(list_devices())
