import argparse
from sqlitedict import SqliteDict
import ujson
import random
import os.path

class Markov():
    def __init__(self):
        self.__db_name = "markov_virtual.db"
        self.__order = 10
        self.__output_max = 300

    def get_order(self):
        return self.__order
        
    def open_database(self):
        return SqliteDict(self.__db_name, encode=ujson.dumps, decode=ujson.loads, autocommit=False, journal_mode="WAL")
        
    def contains_profanity(self, msg):
        # code removed, this does a lot of stuff to look for bad words and other things I don't want aniv talking about
        return False

    def is_safe_to_learn(self, channel, name, msg):
        # code removed, does a bunch of stuff to see if we want to allow aniv to learn name's msg in channel's channel
        return True
        
    def learn(self, in_dict):
        db = self.open_database()
        i = 0
        for keyString in in_dict:
            print(i)
            value = in_dict[keyString]
            if keyString in db:
                db_value = db[keyString]
                
                for character in value:
                    if character in db_value:
                        db_value[character] += value[character]
                    else:
                        db_value[character] = value[character]
                        
                db[keyString] = db_value
            else:
                db[keyString] = value
            i += 1
        db.commit()
        db.close()
            
    def hasResponse(self, msg):
        temp = msg[-self.__order:]
        if len(temp) == self.__order:
            db = self.open_database()
            ret = temp in db
            db.close()
            return ret
        return False
        
    def getKey(self, msg):
        return msg[-self.__order:].replace("\n", "\\n")
        
    def trimDataStream(self, msg):
        return msg[-self.__order:]
    
    def gen_attempt(self, db, key):
        msg = ""
        for i in range(self.__output_max):
            if key not in db:
                # fallback: pick a random key
                key = random.choice(list(db.keys()))

            res = db[key]
            if not res:
                return None

            c = random.choices(list(res.keys()), list(res.values()))[0]
            msg += c
            key = key[1:] + c
            if c == '\n':
                break
        return msg


        
    def gen(self, inputString):
        if not inputString:
            return ""
        db = self.open_database()
        attemptCount = 0
        inputString = inputString[-self.__order:]
        while attemptCount < 20:
            output = self.gen_attempt(db, inputString)
            if output:
                output = output.rstrip()
                m = self.contains_profanity(output)
                if m:
                    attemptCount += 1
                    output = None
                else:
                    break
            else:
                attemptCount += 1
        db.close()
        return output
    
    def get_dict_from_buffer(self, in_dict, data):
        for i in range(len(data) - self.__order):
            print(i)
            key = data[i:i+self.__order]
            char = data[i+self.__order]
                
            if not key in in_dict:
                in_dict[key] = dict()
            if not char in in_dict[key]:
                in_dict[key][char] = 0
            in_dict[key][char] += 1
            
        return in_dict
    

markov = Markov()

# if not os.path.isfile("markov_virtual.db"):
#     with open('all_messages.txt', 'r') as file:
#         in_dict = {}
#         buffer = file.read()
#         in_dict = markov.get_dict_from_buffer(in_dict, buffer)
#         markov.learn(in_dict)


parser = argparse.ArgumentParser()
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("-train", metavar="TEXT")
mode.add_argument("-gen", metavar="TEXT")

args = parser.parse_args()

# Process based on mode
if args.train:
    in_dict = {}
    buffer = args.train
    in_dict = markov.get_dict_from_buffer(in_dict, buffer)
    markov.learn(in_dict)

elif args.gen:
    if markov.hasResponse(args.gen):
        print(markov.gen(args.gen))
    else:
        print(None)
